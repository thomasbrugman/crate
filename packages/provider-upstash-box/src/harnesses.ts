import { ProviderDriverKind } from "@t3tools/contracts";

/** The agents that can run inside a thread's Upstash Box. The Box itself is the environment. */
export type BoxHarness = "commandCode" | "claudeCode" | "codex";

export const BOX_HARNESS_DRIVER_KINDS = {
  commandCode: ProviderDriverKind.make("boxCommandCode"),
  claudeCode: ProviderDriverKind.make("boxClaudeCode"),
  codex: ProviderDriverKind.make("boxCodex"),
} as const satisfies Record<BoxHarness, ProviderDriverKind>;

export const BOX_HARNESS_LABELS = {
  commandCode: "Command Code",
  claudeCode: "Claude Code",
  codex: "Codex",
} as const satisfies Record<BoxHarness, string>;

const boxDriverKinds = new Set<string>(Object.values(BOX_HARNESS_DRIVER_KINDS));

/** Whether a provider runs inside an Upstash Box rather than on the server's machine. */
export function isUpstashBoxDriver(driver: string | null | undefined): boolean {
  return driver != null && boxDriverKinds.has(driver);
}
