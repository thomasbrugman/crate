import type { UsageProviderKind } from "@t3tools/contracts";
import type { AnyProviderDriver } from "@t3tools/provider-core/server/driver";
import type {
  ProviderUsageReader,
  TranscriptUsageFormat,
} from "@t3tools/provider-core/server/usage";
import type { BoxHarness } from "@t3tools/provider-upstash-box/harnesses";
import {
  BoxClaudeCodeDriver,
  BoxCodexDriver,
  BoxCommandCodeDriver,
  boxTranscriptMirrorDir,
  commandCodeUsageFormat,
  type UpstashBoxDriverEnv,
} from "@t3tools/provider-upstash-box/server";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { claudeUsageFormat } from "./Drivers/claudeUsage.ts";
import { codexUsageFormat } from "./Drivers/codexUsage.ts";

export type BuiltInDriversEnv = UpstashBoxDriverEnv;
export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [
  BoxCommandCodeDriver,
  BoxClaudeCodeDriver,
  BoxCodexDriver,
];

export type BuiltInUsageReadersEnv = Path.Path | ServerConfig.ServerConfig;

/** Box harness transcripts are read from the copies the Box adapter keeps under the state dir. */
const boxTranscripts = <State>(
  harness: BoxHarness,
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
