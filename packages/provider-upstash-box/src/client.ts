import { defineProviderClient } from "@t3tools/provider-core/client";

import { BOX_HARNESS_DRIVER_KINDS, BOX_HARNESS_LABELS } from "./harnesses.ts";
import { BoxCommandCodeSettings, BoxManagedAgentSettings } from "./settings.ts";

export const boxCommandCodeClient = defineProviderClient({
  driverKind: BOX_HARNESS_DRIVER_KINDS.commandCode,
  label: BOX_HARNESS_LABELS.commandCode,
  settingsSchema: BoxCommandCodeSettings,
});

export const boxClaudeCodeClient = defineProviderClient({
  driverKind: BOX_HARNESS_DRIVER_KINDS.claudeCode,
  label: BOX_HARNESS_LABELS.claudeCode,
  modelFamilies: ["Claude "],
  settingsSchema: BoxManagedAgentSettings,
});

export const boxCodexClient = defineProviderClient({
  driverKind: BOX_HARNESS_DRIVER_KINDS.codex,
  label: BOX_HARNESS_LABELS.codex,
  modelFamilies: ["GPT-", "GPT "],
  settingsSchema: BoxManagedAgentSettings,
});

export const boxProviderClients = [boxCommandCodeClient, boxClaudeCodeClient, boxCodexClient];
