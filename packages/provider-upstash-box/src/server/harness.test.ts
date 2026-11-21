import * as NodeEvents from "node:events";
import * as NodeVM from "node:vm";
import { assert, it } from "@effect/vitest";

import { commandCodeHarness } from "./harness.ts";

function setup() {
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
  NodeVM.runInNewContext(commandCodeHarness.replace(/^import .*;$/m, ""), {
    spawn: () => child,
    process: {
      argv: ["node", "harness", "-p", "test"],
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
  });
  return {
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

it("preserves Command Code call IDs through box-sse-v1 for concurrent calls completing in reverse order", () => {
  const { frame, events } = setup();
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

it("ignores malformed frames, preserves empty results and reports process errors", () => {
  const { child, frame, events } = setup();
  child.stdout.write("not json\n");
  assert.deepEqual(events(), []);
  frame({ type: "tool_completed", toolCallId: "empty", result: null });
  child.emit("error", new Error("spawn failed"));
  assert.deepEqual(events(), [
    { event: "tool_result", data: { tool_call_id: "empty", output: null } },
    { event: "error", data: { error: "failed to start command-code: spawn failed" } },
  ]);
});
