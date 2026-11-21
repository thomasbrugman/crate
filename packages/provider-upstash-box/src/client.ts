import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { UpstashBoxSettings } from "./settings.ts";

export const upstashBoxClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("upstashBox"),
  label: "Upstash Box",
  settingsSchema: UpstashBoxSettings,
});
