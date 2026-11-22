import type { ExecStreamChunk } from "@upstash/box";
import { expect, it } from "vite-plus/test";

import type { BoxHandle } from "./BoxApi.ts";
import { execHarness } from "./execHarness.ts";

function fakeBox(pieces: ReadonlyArray<string>, exitCode: number): BoxHandle {
  return {
    id: "box",
    exec: {
      command: async () => ({ stdout: "", exitCode: 0 }),
      stream: async () => ({
        id: "run",
        cancel: async () => undefined,
        async *[Symbol.asyncIterator](): AsyncGenerator<ExecStreamChunk> {
          for (const data of pieces) yield { type: "output", data };
          yield { type: "exit", exitCode, cpuNs: 0 };
        },
      }),
    },
    agent: {
      stream: async () => {
        throw new Error("must not use the native agent");
      },
    },
    files: { write: async () => undefined },
    delete: async () => undefined,
    resume: async () => undefined,
    getStatus: async () => ({ status: "idle" }),
  };
}

it("restores fragmented harness frames and commits the session only after a successful exit", async () => {
  const done = 'event: done\ndata: {"session_id":"provider-session"}\n\n';
  const output = ['event: text\ndata: {"text":"test"}\n', "\n" + done];
  const successful = await execHarness(fakeBox(output, 0), "fixture");
  const failed = await execHarness(fakeBox(output, 1), "fixture");
  expect(await Array.fromAsync(successful)).toMatchObject([
    { type: "start", runId: "run" },
    { type: "text-delta", text: "test" },
    { type: "finish", sessionId: "provider-session" },
  ]);
  await expect(Array.fromAsync(failed)).rejects.toThrow("The harness could not complete the turn.");
});

it("does not expose a malformed frame as an error message", async () => {
  const stream = await execHarness(
    fakeBox(["event: text\ndata: private fixture\n\n"], 0),
    "fixture",
  );
  await expect(Array.fromAsync(stream)).rejects.toThrow(
    "The harness returned an invalid stream frame.",
  );
});
