import * as Effect from "effect/Effect";

import { BoxRuntimeError, type BoxHandle, type BoxStream } from "./BoxApi.ts";

export const killHarnessTrees = `node <<'T3_KILL_HARNESS'
const fs = require('node:fs');
const rows = new Map();
for (const name of fs.readdirSync('/proc')) {
  if (!/^\\d+$/.test(name) || Number(name) <= 1) continue;
  try {
    const stat = fs.readFileSync('/proc/' + name + '/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const argv = fs.readFileSync('/proc/' + name + '/cmdline', 'utf8').split('\\0');
    rows.set(Number(name), { parent: Number(fields[1]), start: fields[19], argv });
  } catch (error) {
    if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) throw error;
  }
}
const killed = new Set();
function killTree(pid) {
  if (killed.has(pid) || pid <= 1 || pid === process.pid) return;
  killed.add(pid);
  for (const [child, row] of rows) if (row.parent === pid) killTree(child);
  try {
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    if (stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === rows.get(pid).start)
      process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
  }
}
for (const [pid, row] of rows)
  if (row.argv.some(arg => arg === 't3stash-harness.mjs' || arg.endsWith('/t3stash-harness.mjs')))
    killTree(pid);
T3_KILL_HARNESS`;

export const cancelBoxRun = Effect.fn("UpstashBox.cancelBoxRun")(function* (
  box: BoxHandle,
  stream: BoxStream,
) {
  yield* Effect.tryPromise({
    try: () => stream.cancel(),
    catch: () => new BoxRuntimeError({ operation: "cancel" }),
  }).pipe(
    Effect.interruptible,
    Effect.timeout("4 seconds"),
    Effect.mapError(() => new BoxRuntimeError({ operation: "cancel" })),
    Effect.ensuring(
      Effect.tryPromise({
        try: async () => {
          const result = await box.exec.command(killHarnessTrees);
          if (result.exitCode !== 0) throw new Error("Process cleanup failed");
        },
        catch: () => new BoxRuntimeError({ operation: "kill-harness" }),
      }).pipe(
        Effect.interruptible,
        Effect.timeout("4 seconds"),
        Effect.catch(() => Effect.logWarning("Could not stop the Box agent process tree")),
      ),
    ),
    Effect.uninterruptible,
  );
});
