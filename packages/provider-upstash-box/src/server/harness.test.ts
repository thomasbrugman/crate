import * as NodeEvents from "node:events";
import * as NodeVM from "node:vm";
import { assert, it } from "@effect/vitest";

import { commandCodeHarness } from "./harness.ts";

async function setup(
  options: {
    prompt?: string;
    session?: string;
    explicitSession?: boolean;
    files?: Record<string, { mtimeMs: number; header: unknown }>;
    unavailable?: boolean;
    plan?: boolean;
  } = {},
) {
  const pipe = () => {
    const emitter = new NodeEvents.EventEmitter();
    return Object.assign(emitter, {
      setEncoding: () => undefined,
      write(text: string) {
        emitter.emit("data", text);
      },
    });
  };
  const child = Object.assign(new NodeEvents.EventEmitter(), {
    stdout: pipe(),
    stderr: pipe(),
  });
  let output = "";
  let args: string[] = [];
  let env: Record<string, string> = {};
  const written = new Map<string, string>();
  await NodeVM.runInNewContext(
    `(async () => {${commandCodeHarness.replace(/^#!.*$|^import .*;$/gm, "")}})()`,
    {
      readdirSync: (path: string) => {
        if (options.unavailable) throw new Error("unreadable");
        return path.endsWith("/projects") ? ["project"] : Object.keys(options.files ?? {});
      },
      statSync: (path: string) => options.files?.[path.split("/").at(-1)!],
      openSync: (path: string) => path.split("/").at(-1),
      readSync: (fd: string, buffer: Buffer) =>
        buffer.write(JSON.stringify(options.files?.[fd]?.header) + "\n"),
      closeSync: () => undefined,
      writeFileSync: (path: string, content: string) => written.set(path, content),
      Buffer,
      join: (...parts: string[]) => parts.join("/"),
      homedir: () => "/home/boxuser",
      spawn: (_bin: string, value: string[], options: { env: Record<string, string> }) => {
        args = [...value];
        env = options.env;
        return child;
      },
      process: {
        argv: [
          "node",
          "harness",
          "-p",
          options.prompt ?? "test",
          ...(options.explicitSession ? ["--explicit-session"] : []),
          ...(options.session ? ["--session", options.session] : []),
          ...(options.plan ? ["--plan"] : []),
        ],
        env: { BOXJOB_CC_BIN: "command-code" },
        cwd: () => "/workspace/home",
        stdout: {
          write: (text: string) => {
            output += text;
          },
        },
        stderr: { write: () => undefined },
        exit: () => undefined,
      },
    },
  );
  return {
    args,
    env,
    written,
    child,
    frame: (event: Record<string, unknown>) => {
      child.stdout.write(JSON.stringify({ type: "event", event }) + "\n");
    },
    events: () =>
      output
        .trim()
        .split("\n\n")
        .filter(Boolean)
        .map((frame) => {
          const [event, data] = frame.split("\n");
          return { event: event?.slice(7), data: JSON.parse(data!.slice(6)) };
        }),
  };
}

it("resumes the newest matching Command Code transcript only when no session was supplied", async () => {
  const files = {
    "older.jsonl": { mtimeMs: 1, header: { type: "session", id: "older", cwd: "/workspace/home" } },
    "newer.jsonl": { mtimeMs: 2, header: { type: "session", id: "newer", cwd: "/workspace/home" } },
    "other.jsonl": { mtimeMs: 3, header: { type: "session", id: "other", cwd: "/other" } },
    "broken.jsonl": { mtimeMs: 4, header: {} },
  };
  const normal = await setup({ files });
  assert.include(normal.args.join(" "), "--resume newer");
  assert.equal(normal.env.HOME, "/dev/shm/crate-auth/command-home");
  assert.include((await setup({ files, session: "explicit" })).args.join(" "), "--resume explicit");
  assert.notInclude((await setup({ files, explicitSession: true })).args, "--resume");
  assert.notInclude((await setup()).args, "--resume");
  assert.notInclude((await setup({ unavailable: true })).args, "--resume");
});

it("strips only the outer run marker before invoking Command Code", async () => {
  for (const prompt of ["hello", "crate-run:abcd\nliteral user text"]) {
    const { args } = await setup({ prompt: `crate-run:6162\n${prompt}` });
    assert.equal(args[1], prompt);
  }
  const malformed = "crate-run:not-hex\nhello";
  assert.equal((await setup({ prompt: malformed })).args[1], malformed);
  assert.deepEqual((await setup({ prompt: "crate-run:6162\n" })).events(), [
    { event: "error", data: { error: "no prompt received from the box" } },
  ]);
});

it("preserves Command Code call IDs through box-sse-v1 for concurrent calls completing in reverse order", async () => {
  const { frame, events } = await setup();
  for (const toolCallId of ["pwd", "read"]) {
    frame({
      type: "tool_queued",
      toolCallId,
      toolName: "Shell_command",
      input: { command: toolCallId },
    });
    frame({ type: "tool_running", toolCallId, toolName: "Shell_command" });
  }
  frame({
    type: "tool_completed",
    toolCallId: "read",
    toolName: "Shell_command",
    result: "Hello World!",
  });
  frame({
    type: "tool_completed",
    toolCallId: "pwd",
    toolName: "Shell_command",
    result: "/workspace/home/repo",
  });
  assert.deepEqual(events(), [
    {
      event: "tool",
      data: { tool_call_id: "pwd", name: "Shell_command", input: { command: "pwd" } },
    },
    {
      event: "tool",
      data: { tool_call_id: "read", name: "Shell_command", input: { command: "read" } },
    },
    {
      event: "tool_result",
      data: { tool_call_id: "read", name: "Shell_command", output: "Hello World!" },
    },
    {
      event: "tool_result",
      data: { tool_call_id: "pwd", name: "Shell_command", output: "/workspace/home/repo" },
    },
  ]);
});

it("starts plan mode read-only and ends the run at questions and plan approval", async () => {
  const normal = await setup();
  assert.include(normal.args, "--yolo");
  assert.notInclude(normal.args.join(" "), "exit_plan_mode");
  const { args, written } = await setup({ plan: true });
  assert.notInclude(args, "--yolo");
  assert.include(args.join(" "), "--permission-mode plan");
  assert.include(args.join(" "), "--tools-enable todo_write,ask_user_question,exit_plan_mode");
  const mod = written.get(args[args.indexOf("--mod") + 1]!)!;
  let hooks: { beforeToolCall: (call: { toolName: string }) => Promise<unknown> } | undefined;
  new Function(mod.replace("export default", "return"))()({
    hooks: (value: typeof hooks) => (hooks = value),
  });
  assert.deepInclude(await hooks!.beforeToolCall({ toolName: "ask_user_question" }), {
    block: true,
    terminate: true,
  });
  assert.deepInclude(await hooks!.beforeToolCall({ toolName: "exit_plan_mode" }), {
    terminate: true,
  });
  assert.isUndefined(await hooks!.beforeToolCall({ toolName: "shell_command" }));
});

it("forwards reasoning, todo lists, task ledgers, questions and plans", async () => {
  const { child, frame, events } = await setup();
  frame({ type: "thinking_delta", delta: "hmm" });
  const todos = [
    { content: "Plan", status: "in_progress" },
    { content: "Ship", status: "pending" },
  ];
  frame({ type: "tool_queued", toolCallId: "todo", toolName: "todo_write", input: { todos } });
  frame({ type: "tool_running", toolCallId: "todo", toolName: "todo_write" });
  frame({ type: "tool_completed", toolCallId: "todo", toolName: "todo_write", result: "ok" });
  frame({
    type: "tool_queued",
    toolCallId: "c",
    toolName: "task_create",
    input: { subject: "Test" },
  });
  frame({
    type: "tool_completed",
    toolCallId: "c",
    toolName: "task_create",
    result: [{ type: "text", text: "Task #4 created: Test" }],
  });
  frame({
    type: "tool_queued",
    toolCallId: "u",
    toolName: "task_update",
    input: { taskId: "4", status: "completed" },
  });
  frame({ type: "tool_completed", toolCallId: "u", toolName: "task_update", result: "Updated" });
  const questions = [{ question: "Which language?", options: [{ label: "Python" }] }];
  frame({
    type: "tool_queued",
    toolCallId: "ask",
    toolName: "ask_user_question",
    input: { questions },
  });
  frame({
    type: "tool_queued",
    toolCallId: "exit",
    toolName: "exit_plan_mode",
    input: { plan: "# Plan" },
  });
  assert.deepEqual(events(), [
    { event: "reasoning", data: { text: "hmm" } },
    {
      event: "todo",
      data: {
        steps: [
          { text: "Plan", status: "running" },
          { text: "Ship", status: "pending" },
        ],
      },
    },
    { event: "todo", data: { steps: [{ text: "Test", status: "pending" }] } },
    { event: "todo", data: { steps: [{ text: "Test", status: "completed" }] } },
    { event: "question", data: { tool_call_id: "ask", questions } },
    { event: "plan", data: { markdown: "# Plan" } },
  ]);
  child.stdout.write(JSON.stringify({ type: "result", subtype: "error", sessionId: "s1" }) + "\n");
  child.emit("close", 1);
  assert.deepEqual(events().at(-1), {
    event: "done",
    data: { output: "", input_tokens: 0, output_tokens: 0, session_id: "s1" },
  });
});

it("ignores malformed frames, preserves empty results and reports process errors", async () => {
  const { child, frame, events } = await setup();
  child.stdout.write("not json\n");
  assert.deepEqual(events(), []);
  frame({ type: "tool_completed", toolCallId: "empty", result: null });
  child.emit("error", new Error("spawn failed"));
  assert.deepEqual(events(), [
    { event: "tool_result", data: { tool_call_id: "empty", output: null } },
    { event: "error", data: { error: "Could not start Command Code" } },
  ]);
});
