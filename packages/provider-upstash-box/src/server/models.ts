import type { ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { ClaudeCode, OpenAICodex } from "@upstash/box";

import type { BoxHarness } from "../harnesses.ts";

export const COMMAND_CODE_TEMPLATE_MODEL = "default";

const DEFAULT_MODELS = {
  commandCode: COMMAND_CODE_TEMPLATE_MODEL,
  claudeCode: ClaudeCode.Opus_5,
  codex: OpenAICodex.GPT_5_5,
} as const satisfies Record<BoxHarness, string>;

const BOX_MODEL_CAPABILITIES = createModelCapabilities({
  optionDescriptors: [
    {
      id: "agent",
      label: "Agent",
      type: "select",
      options: [
        { id: "build", label: "Build", isDefault: true },
        { id: "plan", label: "Plan" },
      ],
      currentValue: "build",
    },
  ],
});

const words = (value: string) =>
  value
    .split("-")
    .map((word) => (/^\d/.test(word) ? word : word[0]!.toUpperCase() + word.slice(1)));

/** "anthropic/claude-opus-4-8" is "Claude Opus 4.8"; "openai/gpt-5.3-codex" is "GPT-5.3 Codex". */
export function boxModelName(slug: string): string {
  const id = slug.slice(slug.indexOf("/") + 1);
  const claude = /^claude-([a-z]+)-(\d+(?:-\d+)?)$/.exec(id);
  if (claude) return `Claude ${words(claude[1]!).join(" ")} ${claude[2]!.replace("-", ".")}`;
  const gpt = /^gpt-([\d.]+)(?:-(.+))?$/.exec(id);
  if (gpt) return [`GPT-${gpt[1]}`, ...(gpt[2] ? words(gpt[2]) : [])].join(" ");
  return id;
}

export function boxHarnessModels(harness: BoxHarness): ReadonlyArray<ServerProviderModel> {
  const slugs: ReadonlyArray<string> =
    harness === "commandCode"
      ? [COMMAND_CODE_TEMPLATE_MODEL]
      : Object.values(harness === "claudeCode" ? ClaudeCode : OpenAICodex);
  return slugs.map((slug) => ({
    slug,
    name: slug === COMMAND_CODE_TEMPLATE_MODEL ? "Template default" : boxModelName(slug),
    isCustom: false,
    isDefault: slug === DEFAULT_MODELS[harness],
    supportsTextGeneration: false,
    capabilities: BOX_MODEL_CAPABILITIES,
  }));
}
