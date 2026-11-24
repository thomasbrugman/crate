import { runBoxProviderWorker } from "./provider/boxProviderWorker.ts";

try {
  await runBoxProviderWorker();
} catch {
  process.exitCode = 1;
}
