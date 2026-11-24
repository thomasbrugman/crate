import {
  BoxClaudeCodeDriver,
  BoxCodexDriver,
  BoxCommandCodeDriver,
  makeBoxBackedProviderDriver,
  type UpstashBoxDriverEnv,
} from "@t3tools/provider-upstash-box/server";
import { AntigravitySettings } from "@t3tools/contracts";
import { CursorDriver } from "@t3tools/provider-cursor/server";
import { OpenCodeDriver } from "@t3tools/provider-opencode/server";
import type { AnyProviderDriver } from "@t3tools/provider-core/server/driver";
import * as ModelManifest from "./ModelManifest.ts";
import { AntigravityDriver } from "./Drivers/AntigravityDriver.ts";
import { boxProviderArtifact } from "./boxProviderArtifactSource.ts";

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

export type BuiltInDriversEnv = UpstashBoxDriverEnv;
export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [
  BoxCommandCodeDriver,
  BoxClaudeCodeDriver,
  BoxCodexDriver,
  BoxOpenCodeDriver,
  BoxCursorDriver,
  BoxAntigravityDriver,
];

export type BuiltInUsageReadersEnv = never;
export const BUILT_IN_USAGE_DRIVERS: ReadonlyArray<
  AnyProviderDriver<BuiltInDriversEnv, BuiltInUsageReadersEnv>
> = [];
