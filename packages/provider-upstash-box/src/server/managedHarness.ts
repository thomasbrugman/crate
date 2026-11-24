import { boxMcpStdio } from "./boxMcpStdio.ts";
import { BOX_CREDENTIALS_DIR } from "./credentials.ts";

export const managedHarness = String.raw`import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
${boxMcpStdio}

const [harness, markedPrompt, model, session, kind, relay] = process.argv.slice(2);
const prompt = markedPrompt.replace(/^crate-run:[0-9a-f]+\n/, '');
const emit = (type, data) => process.stdout.write('event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n');
const bridge = relay === 'relay' ? await startBoxMcp(emit) : null;
const binName = harness === 'claudeCode' ? 'claude' : 'codex';
const localBin = '/home/boxuser/.local/bin/' + binName;
const isolateSubagent = 'node -e ' + JSON.stringify(
  'const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));' +
  'console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",updatedInput:{...input.tool_input,isolation:"worktree"}}}));',
);
const claudeSettings = existsSync('.git')
  ? ['--settings', JSON.stringify({ hooks: { PreToolUse: [
      { matcher: 'Agent|Task', hooks: [{ type: 'command', command: isolateSubagent }] },
    ] } })]
  : [];
const mcpArgs = !bridge ? []
  : harness === 'claudeCode'
    ? ['--mcp-config', JSON.stringify({ mcpServers: {
        't3-code': { command: bridge.command, args: bridge.args },
      } })]
    : ['-c', 'mcp_servers.t3-code.command=' + JSON.stringify(bridge.command),
       '-c', 'mcp_servers.t3-code.args=' + JSON.stringify(bridge.args),
       '-c', 'mcp_servers.t3-code.tool_timeout_sec=3900'];
const args = harness === 'claudeCode'
  ? ['--print', '--verbose', '--output-format', 'stream-json', '--include-partial-messages',
     '--permission-mode', 'bypassPermissions', ...claudeSettings, ...mcpArgs, '--model', model,
     ...(session ? ['--resume', session] : []), '--', prompt]
  : [...mcpArgs, 'exec', ...(session ? ['resume'] : []), '--json',
     '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--model', model,
     '--', ...(session ? [session] : []), prompt];
const env = { ...process.env };
env.HOME = '/home/boxuser';
if (harness === 'claudeCode') {
  if (bridge) env.MCP_TOOL_TIMEOUT = '3900000';
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  env.CLAUDE_CONFIG_DIR = '${BOX_CREDENTIALS_DIR}/claude';
  if (kind !== 'file') {
    env[kind === 'token' ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY'] =
      readFileSync('${BOX_CREDENTIALS_DIR}/claudeCode-' + kind, 'utf8');
  }
} else {
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  env.CODEX_HOME = '${BOX_CREDENTIALS_DIR}/codex';
}
const child = spawn(existsSync(localBin) ? localBin : binName, args, {
  stdio: ['ignore', 'pipe', 'ignore'], env,
});
const exited = new Promise(resolve => {
  child.once('error', () => resolve(-1));
  child.once('close', resolve);
});
let sessionId = session;
let sawText = false;
let completed = false;
let reportedError = false;
const text = (value) => {
  if (typeof value !== 'string' || !value) return;
  sawText = true;
  emit('text', { text: value });
};
const done = (usage, output) => {
  completed = true;
  emit('done', {
    output: typeof output === 'string' ? output : '',
    session_id: sessionId,
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
  });
};
const secretTools = new Set();
const tool = (item) => {
  const secret = item.name?.endsWith('__request_secret');
  if (secret) secretTools.add(item.id);
  emit('tool', {
  tool_call_id: item.id,
  name: item.name ?? item.type,
  input: secret ? {} : item.input ?? (typeof item.command === 'string' ? { command: item.command } : {}),
  });
};
const toolResult = (id, output) => emit('tool_result', { tool_call_id: id, output });
const subagentCalls = new Map();
const subagentTasks = new Set();
const isSubagentTool = (name) => name === 'Agent' || name === 'Task';
const handleClaudeSubagent = (frame) => {
  if (frame.type === 'assistant') {
    for (const block of frame.message?.content ?? []) {
      if (block.type === 'tool_use' && isSubagentTool(block.name)) {
        subagentCalls.set(block.id, block.input);
      }
    }
  } else if (frame.type === 'system' && frame.subtype === 'task_started') {
    const call = subagentCalls.get(frame.tool_use_id);
    if (frame.task_type === 'local_agent' || (frame.task_type == null && call)) {
      subagentTasks.add(frame.task_id);
      emit('subagent_started', {
        task_id: frame.task_id,
        parent_task_id: frame.parent_task_id,
        title: frame.description ?? call?.description,
        prompt: frame.prompt ?? call?.prompt,
      });
    }
  } else if (frame.type === 'system' && frame.subtype === 'task_notification' &&
      subagentTasks.delete(frame.task_id)) {
    emit('subagent_finished', {
      task_id: frame.task_id,
      status: frame.status === 'stopped' ? 'cancelled' : frame.status,
      result: frame.summary,
    });
  }
};
for await (const line of createInterface({ input: child.stdout })) {
  let frame;
  try { frame = JSON.parse(line); } catch { continue; }
  if (harness === 'claudeCode') {
    handleClaudeSubagent(frame);
    if (frame.parent_tool_use_id != null) continue;
    if (frame.type === 'system' && frame.subtype === 'init' && typeof frame.session_id === 'string') {
      sessionId = frame.session_id;
    }
    if (frame.type === 'stream_event' && frame.event?.delta?.type === 'text_delta') {
      text(frame.event.delta.text);
    } else if (frame.type === 'assistant') {
      for (const block of frame.message?.content ?? []) {
        if (block.type === 'tool_use' && !isSubagentTool(block.name)) tool(block);
      }
    } else if (frame.type === 'user') {
      for (const block of frame.message?.content ?? []) {
        if (block.type === 'tool_result') {
          toolResult(block.tool_use_id, secretTools.delete(block.tool_use_id) ? null : block.content);
        }
      }
    } else if (frame.type === 'result') {
      if (typeof frame.session_id === 'string') sessionId = frame.session_id;
      if (frame.is_error || frame.subtype !== 'success') reportedError = true;
      else {
        if (!sawText) text(frame.result);
        done(frame.usage, frame.result);
      }
    }
  } else {
    if (frame.type === 'thread.started') sessionId = frame.thread_id;
    if (frame.type === 'item.started' && frame.item?.type === 'command_execution') tool(frame.item);
    if (frame.type === 'item.completed') {
      if (frame.item?.type === 'agent_message') text(frame.item.text);
      if (frame.item?.type === 'command_execution') toolResult(frame.item.id, frame.item.aggregated_output);
    }
    if (frame.type === 'turn.completed') done(frame.usage);
    if (frame.type === 'turn.failed') reportedError = true;
  }
}
const code = await exited;
bridge?.close();
if (!completed || reportedError || code !== 0) process.exitCode = 1;
`;
