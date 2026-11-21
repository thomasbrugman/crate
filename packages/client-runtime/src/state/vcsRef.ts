import type { EnvironmentId, ThreadId, VcsRef as ContractVcsRef } from "@t3tools/contracts";

export interface VcsRefTarget {
  readonly threadId?: ThreadId;
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly query?: string | null;
}

export type VcsRef = ContractVcsRef;
