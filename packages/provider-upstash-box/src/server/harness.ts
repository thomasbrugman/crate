import { boxMcpStdio } from "./boxMcpStdio.ts";
import { BOX_COMMAND_CODE_HOME, BOX_CREDENTIALS_DIR } from "./credentials.ts";

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
import { readdirSync, statSync, openSync, readSync, closeSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
${boxMcpStdio}

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
// Keep the marker in argv for cleanup, but never forward it to Command Code.
const prompt = (readArg(argv, '-p') ?? readArg(argv, '--prompt') ?? '').replace(/^t3stash-run:[0-9a-f]+\\n/, '');
const model = readArg(argv, '--model');
function newestSession() {
	const projects = join(homedir(), '.commandcode', 'projects');
	const cwd = process.env.BOXJOB_CC_CWD || process.cwd();
	let newest;
	try {
		for (const project of readdirSync(projects)) {
			let files;
			try { files = readdirSync(join(projects, project)); } catch { continue; }
			for (const file of files) {
				if (!file.endsWith('.jsonl')) continue;
				try {
					const path = join(projects, project, file);
					const mtime = statSync(path).mtimeMs;
					if (newest && newest.mtime >= mtime) continue;
					const fd = openSync(path, 'r');
					let header;
					try {
						const buffer = Buffer.alloc(8192);
						const length = readSync(fd, buffer, 0, buffer.length, 0);
						header = JSON.parse(buffer.subarray(0, length).toString().split('\\n')[0]);
					} finally { closeSync(fd); }
					if (header.type === 'session' && header.cwd === cwd && typeof header.id === 'string' && header.id)
						newest = { id: header.id, mtime };
				} catch {}
			}
		}
	} catch {}
	return newest?.id;
}

const session = argv.includes('--explicit-session') ? readArg(argv, '--session') : readArg(argv, '--session') || newestSession();

if (!prompt) {
	emit('error', { error: 'no prompt received from the box' });
	process.exit(1);
}

const planMode = argv.includes('--plan');
// Headless Command Code answers its own questions and plan approvals. This mod ends the run
// there instead, so the user's reply arrives as the next message on the saved session.
const handoffMod = '/tmp/t3stash-handoff-mod.ts';
writeFileSync(handoffMod, 'export default (cmd) => cmd.hooks({ beforeToolCall: async ({ toolName }) => ' +
	"(toolName === 'ask_user_question' || toolName === 'exit_plan_mode' ? { block: true, terminate: true, " +
	"additionalContext: 'Shown to the user. Their reply arrives as the next message.' } : undefined) });");
// Print mode withholds these tools; the harness turns them into thread todos, questions and plans.
const args = ['-p', prompt, '--output-format', 'json', '--skip-onboarding',
	'--mod', handoffMod, '--tools-enable', planMode ? 'todo_write,ask_user_question,exit_plan_mode' : 'todo_write,ask_user_question'];
// The box sends its own model label for custom harnesses ("custom" by default);
// only forward it when it is a real Command Code model id.
const passthroughModel = process.env.BOXJOB_CC_MODEL || model;
if (passthroughModel && passthroughModel !== 'custom') args.push('--model', passthroughModel);
if (session) args.push('--resume', session);
if (planMode) args.push('--permission-mode', 'plan');
else if (process.env.BOXJOB_CC_PERMISSION !== 'default') args.push('--yolo');

const env = { ...process.env, HOME: '${BOX_COMMAND_CODE_HOME}' };
const bridge = argv.includes('--t3-mcp-relay') ? await startBoxMcp(emit) : null;
if (argv.includes('--explicit-session')) {
	delete env.COMMAND_CODE_API_KEY;
	try {
		env.COMMAND_CODE_API_KEY = readFileSync('${BOX_CREDENTIALS_DIR}/commandCode-key', 'utf8');
	} catch {}
}
if (bridge) {
	const file = join(env.HOME, '.commandcode', 'mcp.json');
	let config = {};
	try { config = JSON.parse(readFileSync(file, 'utf8')); }
	catch (error) { if (error.code !== 'ENOENT') throw error; }
	const server = { command: bridge.command, args: [process.argv[1], 'mcp'] };
	const mcpServers = { ...config.mcpServers, 't3-code': server };
	if (JSON.stringify(config.mcpServers?.['t3-code']) !== JSON.stringify(server)) {
		const tmp = file + '.' + mcpRandomId();
		writeFileSync(tmp, JSON.stringify({ ...config, mcpServers }), { mode: 0o600, flag: 'wx' });
		renameSync(tmp, file);
	}
	env.T3_BOX_MCP_SOCKET = bridge.address;
	env.MCP_TOOL_TIMEOUT = '3900000';
}
const startedAt = Date.now();
const child = spawn(resolveBin(), args, {
	cwd: process.env.BOXJOB_CC_CWD || process.cwd(),
	stdio: ['ignore', 'pipe', 'ignore'],
	env,
});

let buffer = '';
let sawText = false;
let finalText = '';
let usage = {};
let sessionId = session;
let finished = false;
const announcedTools = new Set();
const handoffTools = new Set(['todo_write', 'task_create', 'task_update', 'ask_user_question', 'exit_plan_mode']);
const taskInputs = new Map();
const tasks = new Map();
const secretTools = new Set();

function exitAfterFlush(code) {
	bridge?.close();
	process.stdout.write('', () => process.exit(code));
}

function finish(event, data) {
	if (finished) return;
	finished = true;
	emit(event, data);
}

const todoStatus = { in_progress: 'running', completed: 'completed' };

function newestPlan() {
	const dir = join(env.HOME, '.commandcode', 'plans');
	let newest;
	try {
		for (const file of readdirSync(dir)) {
			const path = join(dir, file);
			const mtime = statSync(path).mtimeMs;
			if (file.endsWith('.md') && mtime >= startedAt && (!newest || mtime > newest.mtime)) newest = { path, mtime };
		}
		return newest && readFileSync(newest.path, 'utf8');
	} catch {}
}

function emitTasks() {
	emit('todo', { steps: [...tasks.values()] });
}

// Command Code may swap todo_write for its task ledger; the ledger's ids only appear in results.
function handleTaskResult(e) {
	const input = taskInputs.get(e.toolCallId);
	taskInputs.delete(e.toolCallId);
	if (!input) return;
	const result = Array.isArray(e.result) ? e.result.map((part) => part?.text ?? '').join('') : String(e.result ?? '');
	if (e.toolName === 'task_create') {
		const id = /Task #(\\S+) created/.exec(result)?.[1];
		if (!id || typeof input.subject !== 'string') return;
		tasks.set(id, { text: input.subject, status: 'pending' });
	} else {
		const task = tasks.get(String(input.taskId));
		if (!task) return;
		if (input.status === 'deleted') tasks.delete(String(input.taskId));
		else tasks.set(String(input.taskId), {
			text: typeof input.subject === 'string' ? input.subject : task.text,
			status: todoStatus[input.status] || (input.status === 'pending' ? 'pending' : task.status),
		});
	}
	emitTasks();
}

function handleTool(e) {
	const input = e.input || {};
	if (e.toolName === 'task_create' || e.toolName === 'task_update') taskInputs.set(e.toolCallId, input);
	else if (e.toolName === 'todo_write') {
		const todos = Array.isArray(input.todos) ? input.todos : [];
		emit('todo', {
			steps: todos
				.filter((todo) => typeof todo?.content === 'string' && todo.content.trim())
				.map((todo) => ({ text: todo.content, status: todoStatus[todo.status] || 'pending' })),
		});
	} else if (e.toolName === 'ask_user_question') {
		emit('question', { tool_call_id: e.toolCallId, questions: Array.isArray(input.questions) ? input.questions : [] });
	} else if (e.toolName === 'exit_plan_mode') {
		const markdown = newestPlan() || (typeof input.plan === 'string' ? input.plan : '');
		if (markdown.trim()) emit('plan', { markdown });
	}
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
			finish('error', { error: 'Command Code run failed', session_id: sessionId || '' });
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
		case 'thinking_delta':
			if (e.delta) emit('reasoning', { text: e.delta });
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
			if (handoffTools.has(e.toolName)) {
				handleTool(e);
				break;
			}
			const secret = e.toolName?.endsWith('__request_secret');
			if (secret) secretTools.add(id);
			emit('tool', { tool_call_id: e.toolCallId, name: e.toolName, input: secret ? {} : e.input || (e.description ? { description: e.description } : {}) });
			break;
		}
		case 'tool_completed':
			if (handoffTools.has(e.toolName)) {
				if (e.toolName === 'task_create' || e.toolName === 'task_update') handleTaskResult(e);
				break;
			}
			emit('tool_result', { tool_call_id: e.toolCallId, name: e.toolName, output: secretTools.delete(e.toolCallId || e.toolName) ? null : e.result ?? null });
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


child.on('error', () => {
	finish('error', { error: 'Could not start Command Code' });
	exitAfterFlush(1);
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
				error: codeNote,
				session_id: sessionId || '',
			});
		}
	}
	exitAfterFlush(code === 0 ? 0 : 1);
});
`;
