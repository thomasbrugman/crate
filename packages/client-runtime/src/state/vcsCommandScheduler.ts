import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { createAtomCommandScheduler, type AtomCommandConcurrency } from "./runtime.ts";

export const vcsCommandScheduler = createAtomCommandScheduler();

export const vcsCommandConcurrency: AtomCommandConcurrency<{
  readonly environmentId: EnvironmentId;
  readonly input: { readonly cwd: string; readonly threadId?: ThreadId | undefined };
}> = {
  mode: "serial",
  key: ({ environmentId, input }) => JSON.stringify([environmentId, input.cwd, input.threadId]),
};
