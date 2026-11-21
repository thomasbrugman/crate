export const commandCodeHarness = `#!/usr/bin/env node
/*
 * Upstash Box custom harness ("box-sse-v1") backed by Command Code.
 *
 * Box invokes:  <command> <args...> -p "<prompt>" --model "<model>" --stream --session "<sid>"
 * We translate: command-code -p "<prompt>" --output-format json  ->  box-sse-v1 events on stdout.
 *
 * Env:
 *   BOXJOB_CC_BIN         override the binary (default: command-code from a login shell PATH)
 *   BOXJOB_CC_PERMISSION  "default" to keep headless write/shell blocked (default: yolo)
 *   BOXJOB_CC_CWD         working directory for the run (default: process.cwd())
 */

import { spawn, execFileSync } from 'node:child_process';

function readArg(argv, name) {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
}

function emit(event, data) {
	process.stdout.write(\`event: \${event}\\ndata: \${JSON.stringify(data)}\\n\\n\`);
}

function resolveBin() {
	if (process.env.BOXJOB_CC_BIN) return process.env.BOXJOB_CC_BIN;
	try {
		return execFileSync('bash', ['-lc', 'command -v command-code || command -v cmd'], { encoding: 'utf8' }).trim();
	} catch {
		return 'command-code';
	}
}

const argv = process.argv.slice(2);
const prompt = readArg(argv, '-p') ?? readArg(argv, '--prompt') ?? '';
const model = readArg(argv, '--model');
const session = readArg(argv, '--session');

if (!prompt) {
	emit('error', { error: 'no prompt received from the box' });
	process.exit(1);
}

const args = ['-p', prompt, '--output-format', 'json', '--skip-onboarding'];
// The box sends its own model label for custom harnesses ("custom" by default);
// only forward it when it is a real Command Code model id.
const passthroughModel = process.env.BOXJOB_CC_MODEL || model;
if (passthroughModel && passthroughModel !== 'custom') args.push('--model', passthroughModel);
if (session) args.push('--resume', session);
if (process.env.BOXJOB_CC_PERMISSION !== 'default') args.push('--yolo');

const child = spawn(resolveBin(), args, {
	cwd: process.env.BOXJOB_CC_CWD || process.cwd(),
	stdio: ['ignore', 'pipe', 'pipe'],
});

let buffer = '';
let sawText = false;
let finalText = '';
let usage = {};
let sessionId = session;
let finished = false;
let stderrTail = '';
const announcedTools = new Set();

function finish(event, data) {
	if (finished) return;
	finished = true;
	emit(event, data);
}

function handleFrame(frame) {
	let o;
	try {
		o = JSON.parse(frame);
	} catch {
		return;
	}

	if (o.type === 'result') {
		const text = o.finalText || finalText;
		if (!sawText && text) emit('text', { text });
		usage = o.usage || usage;
		sessionId = o.sessionId || sessionId;
		if (o.subtype === 'error') {
			finish('error', { error: o.error || 'command-code run failed', session_id: sessionId || '' });
			return;
		}
		finish('done', {
			output: text,
			input_tokens: usage.inputTokens ?? 0,
			output_tokens: usage.outputTokens ?? 0,
			session_id: sessionId || '',
		});
		return;
	}

	if (o.type !== 'event') return;
	const e = o.event || {};
	switch (e.type) {
		case 'run_start':
			sessionId = e.sessionId || sessionId;
			break;
		case 'text_delta':
			if (e.delta) {
				emit('text', { text: e.delta });
				sawText = true;
			}
			break;
		case 'tool_queued':
		case 'tool_running': {
			const id = e.toolCallId || e.toolName;
			if (announcedTools.has(id)) break;
			announcedTools.add(id);
			emit('tool', { tool_call_id: e.toolCallId, name: e.toolName, input: e.input || (e.description ? { description: e.description } : {}) });
			break;
		}
		case 'tool_completed':
			emit('tool_result', { tool_call_id: e.toolCallId, name: e.toolName, output: e.result ?? null });
			break;
		case 'run_end': {
			const r = e.result || {};
			finalText = r.finalText || finalText;
			usage = r.usage || usage;
			sessionId = r.nextState?.sessionId || sessionId;
			break;
		}
	}
}

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
	buffer += chunk;
	let i;
	while ((i = buffer.indexOf('\\n')) >= 0) {
		const line = buffer.slice(0, i).trim();
		buffer = buffer.slice(i + 1);
		if (line) handleFrame(line);
	}
});

child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
	process.stderr.write(chunk);
	stderrTail = (stderrTail + chunk).slice(-500);
});

child.on('error', (err) => {
	finish('error', { error: \`failed to start command-code: \${err.message}\` });
	process.exit(1);
});

child.on('close', (code) => {
	if (buffer.trim()) handleFrame(buffer.trim());
	if (!finished) {
		if (code === 0) {
			if (!sawText && finalText) emit('text', { text: finalText });
			finish('done', {
				output: finalText,
				input_tokens: usage.inputTokens ?? 0,
				output_tokens: usage.outputTokens ?? 0,
				session_id: sessionId || '',
			});
		} else {
			const codeNote = code === 8 ? 'max turns reached' : \`exit \${code}\`;
			finish('error', {
				error: \`\${codeNote}\${stderrTail ? ': ' + stderrTail.trim().split('\\n').slice(-3).join(' ') : ''}\`,
				session_id: sessionId || '',
			});
		}
	}
	process.exit(code === 0 ? 0 : 1);
});
`;
