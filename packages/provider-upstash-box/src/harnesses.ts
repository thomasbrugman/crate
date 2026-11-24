import { ProviderDriverKind } from "@t3tools/contracts";

/** The agents that can run inside a thread's Upstash Box. The Box itself is the environment. */
export type LegacyBoxHarness = "commandCode" | "claudeCode" | "codex";
export type WorkerBoxHarness = "opencode" | "cursor" | "antigravity";
export type BoxHarness = LegacyBoxHarness | WorkerBoxHarness;

export function isWorkerBoxHarness(harness: BoxHarness): harness is WorkerBoxHarness {
  return harness === "opencode" || harness === "cursor" || harness === "antigravity";
}

export const BOX_HARNESS_DRIVER_KINDS = {
  commandCode: ProviderDriverKind.make("boxCommandCode"),
  claudeCode: ProviderDriverKind.make("boxClaudeCode"),
  codex: ProviderDriverKind.make("boxCodex"),
  opencode: ProviderDriverKind.make("opencode"),
  cursor: ProviderDriverKind.make("cursor"),
  antigravity: ProviderDriverKind.make("antigravity"),
} as const satisfies Record<BoxHarness, ProviderDriverKind>;

export const BOX_HARNESS_LABELS = {
  commandCode: "Command Code",
  claudeCode: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  antigravity: "Antigravity",
} as const satisfies Record<BoxHarness, string>;

const boxDriverHarnesses = new Map<string, BoxHarness>(
  (Object.keys(BOX_HARNESS_DRIVER_KINDS) as BoxHarness[]).map((harness) => [
    BOX_HARNESS_DRIVER_KINDS[harness],
    harness,
  ]),
);

export function getUpstashBoxHarness(driver: string | null | undefined): BoxHarness | undefined {
  return driver == null ? undefined : boxDriverHarnesses.get(driver);
}

const workerDriverKinds = new Set<string>([
  BOX_HARNESS_DRIVER_KINDS.opencode,
  BOX_HARNESS_DRIVER_KINDS.cursor,
  BOX_HARNESS_DRIVER_KINDS.antigravity,
]);

export const isBoxWorkerDriver = (driver: string) => workerDriverKinds.has(driver);

export const boxNameForThread = (threadId: string) => `t3-${Buffer.from(threadId).toString("hex")}`;

/** Whether a provider runs inside an Upstash Box rather than on the server's machine. */
export function isUpstashBoxDriver(driver: string | null | undefined): boolean {
  return getUpstashBoxHarness(driver) !== undefined;
}
