import {
  CustomModelSetting,
  makeProviderSettingsSchema,
  secretSetting,
  SettingsSecretValue,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const customModels = Schema.Array(CustomModelSetting).pipe(
  Schema.withDecodingDefault(Effect.succeed([])),
  Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
);

/** Command Code runs from the template Box's own login, so it has nothing to configure. */
export const BoxCommandCodeSettings = makeProviderSettingsSchema({ customModels });
export type BoxCommandCodeSettings = typeof BoxCommandCodeSettings.Type;

/** Claude Code and Codex run as Box-managed agents that need a model provider key. */
export const BoxManagedAgentSettings = makeProviderSettingsSchema(
  {
    apiKey: SettingsSecretValue.pipe(
      secretSetting,
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Model API key",
        description: "Leave empty to use the key stored in the Upstash console.",
        providerSettingsForm: { control: "password", clearWhenEmpty: "omit" },
      }),
    ),
    customModels,
  },
  { order: ["apiKey"] },
);
export type BoxManagedAgentSettings = typeof BoxManagedAgentSettings.Type;
