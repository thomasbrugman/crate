import { settingsSecretLiteral, type UpstashBoxEnvironmentSettings } from "@t3tools/contracts";

import type { BoxHarness } from "../harnesses.ts";

export type BoxHarnessCredentials = Readonly<Partial<Record<BoxHarness, string>>>;
export const BOX_CREDENTIALS_DIR = "/dev/shm/t3stash-auth";
export const BOX_COMMAND_CODE_HOME = `${BOX_CREDENTIALS_DIR}/command-home`;
export const BOX_HARNESS_AUTH_FIELDS = {
  commandCode: "commandCodeAuth",
  claudeCode: "claudeCodeAuth",
  codex: "codexAuth",
} as const;

export function readHarnessCredentials(box: UpstashBoxEnvironmentSettings): BoxHarnessCredentials {
  return {
    commandCode: settingsSecretLiteral(box.commandCodeAuth),
    claudeCode: settingsSecretLiteral(box.claudeCodeAuth),
    codex: settingsSecretLiteral(box.codexAuth),
  };
}

export function isAuthJson(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length > 0
    );
  } catch {
    return false;
  }
}

export function harnessCredentialKind(harness: BoxHarness, value: string) {
  if (!value?.trim()) return undefined;
  if (value.trimStart().startsWith("{")) return isAuthJson(value) ? "file" : undefined;
  if (/[\s{}]/u.test(value)) return undefined;
  return harness === "claudeCode" && value.startsWith("sk-ant-oat") ? "token" : "key";
}
