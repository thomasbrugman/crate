import {
  BoxSize,
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
    templateBoxName: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("cc-harness")),
      Schema.annotateKey({
        title: "Template Box",
        providerSettingsForm: { placeholder: "cc-harness" },
      }),
    ),
    model: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Model",
        providerSettingsForm: { placeholder: "Template default" },
      }),
    ),
    size: BoxSize.pipe(
      Schema.withDecodingDefault(Effect.succeed("small" as const)),
      Schema.annotateKey({
        title: "Box size",
        providerSettingsForm: {
          control: "select",
          placeholder: "Small",
          options: [
            { value: "small", label: "Small" },
            { value: "medium", label: "Medium" },
            { value: "large", label: "Large" },
          ],
        },
      }),
    ),
  },
  { order: ["apiKey", "templateBoxName", "model", "size"] },
);
export type UpstashBoxSettings = typeof UpstashBoxSettings.Type;
