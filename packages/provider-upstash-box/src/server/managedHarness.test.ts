import * as NodeEvents from "node:events";
import * as NodeVM from "node:vm";
import { assert, it } from "@effect/vitest";

import { managedHarness } from "./managedHarness.ts";

it("keeps Claude subagent frames out of the parent transcript and preserves its session", async () => {
  const child = new NodeEvents.EventEmitter();
  const frames = [
    { type: "system", subtype: "init", session_id: "parent" },
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Agent",
            id: "delegate",
            input: { prompt: "Review the change" },
          },
        ],
      },
    },
    {
      type: "system",
      subtype: "task_started",
      task_type: "local_agent",
      task_id: "reviewer",
      tool_use_id: "delegate",
      description: "Review",
    },
    {
      type: "stream_event",
      parent_tool_use_id: "delegate",
      session_id: "child",
      event: { delta: { type: "text_delta", text: "Child reasoning" } },
    },
    {
      type: "system",
      subtype: "task_notification",
      task_id: "reviewer",
      status: "completed",
      summary: "Review done",
    },
    { type: "result", subtype: "success", result: "Parent response" },
  ];
  const output: string[] = [];
  let args: string[] = [];
  await NodeVM.runInNewContext(
    `(async () => { ${managedHarness.replace(/^import .*;$/gmu, "")} })()`,
    {
      process: {
        argv: ["node", "harness", "claudeCode", "test", "model", "", "token"],
        env: {},
        stdout: { write: (frame: string) => output.push(frame) },
      },
      existsSync: () => true,
      readFileSync: () => "fixture-key",
      spawn: (_bin: string, argv: string[]) => {
        args = argv;
        return child;
      },
      createInterface: async function* () {
        for (const frame of frames) yield JSON.stringify(frame);
        child.emit("close", 0);
      },
    },
  );
  const [start, finish, text, done] = output.map((entry) => {
    const [event, data] = entry.split("\n");
    return { event: event?.slice(7), data: JSON.parse(data!.slice(6)) as unknown };
  });
  assert.deepInclude(start, {
    event: "subagent_started",
    data: { task_id: "reviewer", title: "Review", prompt: "Review the change" },
  });
  assert.deepInclude(finish, {
    event: "subagent_finished",
    data: { task_id: "reviewer", status: "completed", result: "Review done" },
  });
  assert.deepEqual(text, { event: "text", data: { text: "Parent response" } });
  assert.deepInclude(done?.data, { session_id: "parent" });
  assert.include(args[args.indexOf("--settings") + 1], "worktree");
  assert.notInclude(output.join("\n"), "Child reasoning");
});

async function runManaged(argv: string[], frames: unknown[]) {
  const child: NodeEvents.EventEmitter & { killed: boolean; kill(): void } = Object.assign(
    new NodeEvents.EventEmitter(),
    {
      killed: false,
      kill: () => {
        child.killed = true;
        child.emit("close", null);
      },
    },
  );
  const output: string[] = [];
  let args: string[] = [];
  const processStub = {
    argv: ["node", "harness", ...argv],
    env: {},
    exitCode: undefined as number | undefined,
    stdout: { write: (frame: string) => output.push(frame) },
  };
  await NodeVM.runInNewContext(
    `(async () => { ${managedHarness.replace(/^import .*;$/gmu, "")} })()`,
    {
      process: processStub,
      existsSync: () => true,
      readFileSync: () => "fixture-key",
      spawn: (_bin: string, value: string[]) => {
        args = value;
        return child;
      },
      createInterface: async function* () {
        for (const frame of frames) yield JSON.stringify(frame);
        if (!child.killed) child.emit("close", 0);
      },
    },
  );
  const events = output.map((entry) => {
    const [event, data] = entry.split("\n");
    return { event: event?.slice(7), data: JSON.parse(data!.slice(6)) as unknown };
  });
  return { args, events, killed: child.killed, exitCode: processStub.exitCode };
}

it("forwards Claude reasoning and todos and ends the run at a question", async () => {
  const questions = [{ question: "Which language?", options: [{ label: "Python" }] }];
  const { args, events, killed, exitCode } = await runManaged(
    ["claudeCode", "test", "model", "", "token", "plan"],
    [
      { type: "system", subtype: "init", session_id: "parent" },
      { type: "stream_event", event: { delta: { type: "thinking_delta", thinking: "hmm" } } },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "TodoWrite",
              id: "todo",
              input: { todos: [{ content: "Plan", status: "in_progress" }] },
            },
            { type: "tool_use", name: "AskUserQuestion", id: "ask", input: { questions } },
            { type: "tool_use", name: "Bash", id: "late", input: { command: "ls" } },
          ],
        },
      },
      { type: "stream_event", event: { delta: { type: "text_delta", text: "self-answered" } } },
    ],
  );
  assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
  assert.deepEqual(events, [
    { event: "reasoning", data: { text: "hmm" } },
    { event: "todo", data: { steps: [{ text: "Plan", status: "running" }] } },
    { event: "question", data: { tool_call_id: "ask", questions } },
    {
      event: "done",
      data: { output: "", session_id: "parent", input_tokens: 0, output_tokens: 0 },
    },
  ]);
  assert.isTrue(killed);
  assert.isUndefined(exitCode);
});

it("runs a resumed Codex plan turn read-only with the sandbox flag ahead of resume", async () => {
  const { args } = await runManaged(
    ["codex", "Refine it", "model", "sess-1", "token", "plan"],
    [{ type: "turn.completed", usage: { input_tokens: 0, output_tokens: 0 } }],
  );
  const sandbox = args.indexOf("--sandbox");
  assert.isAtLeast(sandbox, args.indexOf("exec"));
  assert.isBelow(sandbox, args.indexOf("resume"));
  assert.equal(args[sandbox + 1], "read-only");
  assert.equal(args[args.indexOf("--") + 1], "sess-1");
  assert.notInclude(args, "--dangerously-bypass-approvals-and-sandbox");
});

it("turns a Codex plan-mode reply into a proposed plan and forwards its todo list", async () => {
  const { args, events } = await runManaged(
    ["codex", "Add hello", "model", "", "token", "plan"],
    [
      { type: "thread.started", thread_id: "thread" },
      { type: "item.completed", item: { type: "reasoning", text: "hmm" } },
      {
        type: "item.started",
        item: { type: "todo_list", items: [{ text: "Plan", completed: true }] },
      },
      {
        type: "item.completed",
        item: { type: "agent_message", text: "Here.\n<proposed_plan>\n# Plan\n</proposed_plan>" },
      },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } },
    ],
  );
  assert.include(args.join(" "), "<proposed_plan>");
  assert.include(args.join(" "), "Add hello");
  assert.deepEqual(
    events.map((entry) => [entry.event, entry.data]),
    [
      ["reasoning", { text: "hmm" }],
      ["todo", { steps: [{ text: "Plan", status: "completed" }] }],
      ["text", { text: "Here." }],
      ["plan", { markdown: "# Plan" }],
      ["done", { output: "", session_id: "thread", input_tokens: 1, output_tokens: 2 }],
    ],
  );
});

it("runs review guide investigations with read-only harness permissions", async () => {
  const argsFor = (harness: string) =>
    runManaged([harness, "guide", "model", "", "key", "investigate"], []).then(({ args }) => args);
  const claude = await argsFor("claudeCode");
  assert.include(claude.join(" "), "--permission-mode dontAsk");
  assert.notInclude(claude, "bypassPermissions");
  assert.equal(claude[claude.indexOf("--tools") + 1], "Read,Grep,Glob,Bash");
  const codex = await argsFor("codex");
  assert.include(codex.join(" "), "--sandbox read-only");
  assert.notInclude(codex, "--dangerously-bypass-approvals-and-sandbox");
});
