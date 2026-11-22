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
