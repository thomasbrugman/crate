import * as NodeVM from "node:vm";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import type { BoxHandle, BoxStream } from "./BoxApi.ts";
import { cancelBoxRun, killHarnessTrees } from "./stop.ts";

function executeCleanup(
  command: string,
  rows: ReadonlyMap<number, { parent: number; argv: string[] }>,
) {
  const killed: number[] = [];
  const reads = new Map<number, number>();
  NodeVM.runInNewContext(command.split("\n").slice(1, -1).join("\n"), {
    require: () => ({
      readdirSync: () => [...rows.keys()].map(String),
      readFileSync: (path: string) => {
        const pid = Number(path.split("/")[2]);
        const row = rows.get(pid)!;
        if (path.endsWith("cmdline")) return row.argv.join("\0");
        const count = reads.get(pid) ?? 0;
        reads.set(pid, count + 1);
        const fields = Array<string>(20).fill("0");
        fields[1] = String(row.parent);
        fields[19] = pid === 5 && count > 0 ? "reused" : "original";
        return `${pid} (process) ${fields.join(" ")}`;
      },
    }),
    process: { pid: 99, kill: (pid: number) => killed.push(pid) },
  });
  return killed;
}

it("kills harness descendants child-first without killing exec roots, PID 1 or reused PIDs", () => {
  for (const root of [true, false]) {
    const marker = "t3stash-run:6f6c64\n";
    const command = killHarnessTrees(marker);
    const rows = new Map([
      [1, { parent: 0, argv: ["init"] }],
      [
        2,
        {
          parent: 0,
          argv: [
            "node",
            root ? "/bin/t3stash-harness.mjs" : "/bin/other.mjs",
            "-p",
            marker + "same prompt",
          ],
        },
      ],
      [3, { parent: 2, argv: ["command-code"] }],
      [4, { parent: 3, argv: ["sh", "-c", "sleep 90"] }],
      [5, { parent: 4, argv: ["sleep", "90"] }],
      [6, { parent: 0, argv: ["sh", "-c", command] }],
      [7, { parent: 0, argv: ["node", "/bin/t3stash-harness.mjs", "-p", "unmarked prompt"] }],
    ]);
    const killed = executeCleanup(command, rows);
    assert.deepEqual(killed, root ? [4, 3, 2] : []);
  }
});

it.effect("does not kill a follow-up harness when remote cleanup executes after its timeout", () =>
  Effect.gen(function* () {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const executed = Promise.withResolvers<void>();
    const marker = "t3stash-run:6f6c64\n";
    const rows = new Map([
      [2, { parent: 0, argv: ["node", "/bin/t3stash-harness.mjs", "-p", marker + "same prompt"] }],
      [3, { parent: 2, argv: ["command-code"] }],
    ]);
    const killed: number[] = [];
    const unused = async (): Promise<never> => {
      throw new Error("unused");
    };
    const box: BoxHandle = {
      id: "box",
      agent: { stream: unused },
      files: { write: unused },
      delete: unused,
      resume: unused,
      getStatus: unused,
      exec: {
        command: async (command) => {
          entered.resolve();
          await release.promise;
          killed.push(...executeCleanup(command, rows));
          executed.resolve();
          return { stdout: "", exitCode: 0 };
        },
      },
    };
    const stream: BoxStream = {
      id: "old-run",
      cancel: async () => undefined,
      [Symbol.asyncIterator]: () => {
        throw new Error("unused");
      },
    };
    const cancelling = yield* cancelBoxRun(box, stream, marker).pipe(Effect.forkChild);
    yield* Effect.promise(() => entered.promise);
    yield* TestClock.adjust("4 seconds");
    yield* Fiber.join(cancelling);
    rows.set(7, {
      parent: 0,
      argv: ["node", "/bin/t3stash-harness.mjs", "-p", "t3stash-run:6e6577\nsame prompt"],
    });
    rows.set(8, { parent: 7, argv: ["command-code"] });
    release.resolve();
    yield* Effect.promise(() => executed.promise);
    assert.deepEqual(killed, [3, 2]);
  }),
);
