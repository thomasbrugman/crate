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

const boxDriverHarnesses = new Map<string, BoxHarness>(
  (Object.keys(BOX_HARNESS_DRIVER_KINDS) as BoxHarness[]).map((harness) => [
    BOX_HARNESS_DRIVER_KINDS[harness],
    harness,
  ]),
);

export function getUpstashBoxHarness(driver: string | null | undefined): BoxHarness | undefined {
  return driver == null ? undefined : boxDriverHarnesses.get(driver);
}

/** Whether a provider runs inside an Upstash Box rather than on the server's machine. */
export function isUpstashBoxDriver(driver: string | null | undefined): boolean {
  return getUpstashBoxHarness(driver) !== undefined;
}
