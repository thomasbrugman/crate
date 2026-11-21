import {
  makeProviderSettingsSchema,
  secretSetting,
  SettingsSecretValue,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const UpstashBoxSettings = makeProviderSettingsSchema(
  {
    apiKey: SettingsSecretValue.pipe(
      secretSetting,
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "API key",
        providerSettingsForm: { control: "password", clearWhenEmpty: "omit" },
      }),
    ),
    templateBoxName: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed("cc-harness"))),
    model: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
    size: Schema.Literals(["small", "medium", "large"]).pipe(
      Schema.withDecodingDefault(Effect.succeed("small" as const)),
    ),
  },
  { order: ["apiKey", "templateBoxName", "model", "size"] },
);
export type UpstashBoxSettings = typeof UpstashBoxSettings.Type;
