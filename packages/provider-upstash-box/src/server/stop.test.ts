import * as NodeVM from "node:vm";
import { assert, it } from "@effect/vitest";

import { killHarnessTrees } from "./stop.ts";

it("kills harness descendants child-first without killing exec roots, PID 1 or reused PIDs", () => {
  for (const root of [true, false]) {
    const killed: number[] = [];
    const reads = new Map<number, number>();
    const rows = new Map([
      [1, { parent: 0, argv: ["init"] }],
      [2, { parent: 0, argv: ["node", root ? "/bin/t3stash-harness.mjs" : "/bin/other.mjs"] }],
      [3, { parent: 2, argv: ["command-code"] }],
      [4, { parent: 3, argv: ["sh", "-c", "sleep 90"] }],
      [5, { parent: 4, argv: ["sleep", "90"] }],
      [6, { parent: 0, argv: ["sh", "-c", killHarnessTrees] }],
    ]);
    NodeVM.runInNewContext(killHarnessTrees.split("\n").slice(1, -1).join("\n"), {
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
    assert.deepEqual(killed, root ? [4, 3, 2] : []);
  }
});
