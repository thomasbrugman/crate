import type { UsageProviderKind } from "@t3tools/contracts";
import type { AnyProviderDriver } from "@t3tools/provider-core/server/driver";
import type {
  ProviderUsageReader,
  TranscriptUsageFormat,
} from "@t3tools/provider-core/server/usage";
import type { LegacyBoxHarness } from "@t3tools/provider-upstash-box/harnesses";
import {
  BoxClaudeCodeDriver,
  BoxCodexDriver,
  BoxCommandCodeDriver,
  makeBoxBackedProviderDriver,
  boxTranscriptMirrorDir,
  commandCodeUsageFormat,
  type UpstashBoxDriverEnv,
} from "@t3tools/provider-upstash-box/server";
import { AntigravitySettings } from "@t3tools/contracts";
import { CursorDriver } from "@t3tools/provider-cursor/server";
import { GrokDriver } from "@t3tools/provider-grok/server";
import { KiroDriver } from "@t3tools/provider-kiro/server";
import { MuseDriver } from "@t3tools/provider-muse/server";
import { OpenCodeDriver } from "@t3tools/provider-opencode/server";
import * as ModelManifest from "./ModelManifest.ts";
import { AntigravityDriver } from "./Drivers/AntigravityDriver.ts";
import { boxProviderArtifact } from "./boxProviderArtifactSource.ts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { claudeUsageFormat } from "./Drivers/claudeUsage.ts";
import { codexUsageFormat } from "./Drivers/codexUsage.ts";

const BoxOpenCodeDriver = makeBoxBackedProviderDriver("opencode", OpenCodeDriver.configSchema, {
  artifact: boxProviderArtifact,
  settings: ({ customModels }) => ({ customModels }),
  models: [],
});
const BoxCursorDriver = makeBoxBackedProviderDriver("cursor", CursorDriver.configSchema, {
  artifact: boxProviderArtifact,
  settings: ({ customModels }) => ({ customModels }),
  models: [],
});
const BoxAntigravityDriver = makeBoxBackedProviderDriver("antigravity", AntigravitySettings, {
  artifact: boxProviderArtifact,
  settings: ({ customModels, enabled }) => ({ customModels, enabled }),
  models: (
    ModelManifest.resolveProviderCatalog(
      ModelManifest.BUNDLED_MODEL_MANIFEST,
      AntigravityDriver.driverKind,
      0,
    )?.models ?? []
  ).map((model) => ({
    slug: model.slug,
    name: model.name,
    isCustom: false,
    capabilities: model.capabilities,
  })),
});

const BoxGrokDriver = makeBoxBackedProviderDriver("grok", GrokDriver.configSchema, {
  artifact: boxProviderArtifact,
  settings: ({ customModels }) => ({ customModels }),
  models: [],
});
const BoxKiroDriver = makeBoxBackedProviderDriver("kiro", KiroDriver.configSchema, {
  artifact: boxProviderArtifact,
  settings: ({ customModels }) => ({ customModels }),
  models: [],
});
const BoxMuseDriver = makeBoxBackedProviderDriver("muse", MuseDriver.configSchema, {
  artifact: boxProviderArtifact,
  settings: ({ customModels }) => ({ customModels }),
  models: [],
});

export type BuiltInDriversEnv = UpstashBoxDriverEnv;
export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [
  BoxCommandCodeDriver,
  BoxClaudeCodeDriver,
  BoxCodexDriver,
  BoxOpenCodeDriver,
  BoxCursorDriver,
  BoxAntigravityDriver,
  BoxGrokDriver,
  BoxKiroDriver,
  BoxMuseDriver,
];

export type BuiltInUsageReadersEnv = Path.Path | ServerConfig.ServerConfig;

/** Box harness transcripts are read from the copies the Box adapter keeps under the state dir. */
const boxTranscripts = <State>(
  harness: LegacyBoxHarness,
  provider: UsageProviderKind,
  format: TranscriptUsageFormat<State>,
): ProviderUsageReader<unknown, BuiltInUsageReadersEnv> => ({
  kind: "transcripts",
  provider,
  format: format as TranscriptUsageFormat<unknown>,
  directories: Effect.fn("boxTranscripts.directories")(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return [{ dir: boxTranscriptMirrorDir(path, config.stateDir, harness) }];
  }),
});

// Order matters: aggregation keeps the first duplicate record.
export const BUILT_IN_USAGE_DRIVERS: ReadonlyArray<
  AnyProviderDriver<BuiltInDriversEnv, BuiltInUsageReadersEnv>
> = [
  {
    ...BoxCommandCodeDriver,
    usage: boxTranscripts("commandCode", "commandCode", commandCodeUsageFormat),
  },
  { ...BoxClaudeCodeDriver, usage: boxTranscripts("claudeCode", "claude", claudeUsageFormat) },
  { ...BoxCodexDriver, usage: boxTranscripts("codex", "codex", codexUsageFormat) },
];
