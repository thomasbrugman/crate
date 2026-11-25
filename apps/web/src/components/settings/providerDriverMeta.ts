import { ProviderDriverKind } from "@t3tools/contracts";
import { providerClients as sharedClients } from "@t3tools/client-runtime/provider-clients";
import { defineProviderClient, makeProviderClientRegistry } from "@t3tools/provider-core/client";
import { cursorClient } from "@t3tools/provider-cursor/client";
import { grokClient } from "@t3tools/provider-grok/client";
import { kiroClient } from "@t3tools/provider-kiro/client";
import { museClient } from "@t3tools/provider-muse/client";
import { openCodeClient } from "@t3tools/provider-opencode/client";
import { isBoxWorkerDriver } from "@t3tools/provider-upstash-box/harnesses";
import { BoxCommandCodeSettings } from "@t3tools/provider-upstash-box/settings";

export const providerClients = makeProviderClientRegistry([
  ...sharedClients.definitions.filter(({ driverKind }) => !isBoxWorkerDriver(driverKind)),
  { ...cursorClient, environmentFields: [] },
  { ...openCodeClient, settingsSchema: BoxCommandCodeSettings },
  defineProviderClient({
    driverKind: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    settingsSchema: BoxCommandCodeSettings,
  }),
  grokClient,
  { ...kiroClient, environmentFields: [] },
  museClient,
]);
