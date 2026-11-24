import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export interface ComposerPathSearchEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly parentPath?: string;
}

export interface ComposerPathSearchTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly boxThreadId?: ThreadId | undefined;
  readonly query: string | null;
}
