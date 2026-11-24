import {
  DEFAULT_SERVER_SETTINGS,
  settingsSecretLiteral,
  TextGenerationError,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import type { IdAllocatorV2 } from "@t3tools/provider-core/server/IdAllocator";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";
import { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import { providerModelsFromSettings } from "@t3tools/provider-core/server/snapshotProbe";
import { BoxError } from "@upstash/box";
import * as DateTime from "effect/DateTime";
import * as Config from "effect/Config";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { BOX_HARNESS_DRIVER_KINDS, BOX_HARNESS_LABELS, type BoxHarness } from "../harnesses.ts";
import { BoxCommandCodeSettings, BoxManagedAgentSettings } from "../settings.ts";
import { makeUpstashBoxAdapter, type BoxEnvironmentConfig } from "./adapter.ts";
import { makeBoxHarnessAuth } from "./auth.ts";
import { readCommandCodeUsageLimits } from "./commandCodeUsage.ts";
import { boxTranscriptMirrorDir, mirrorBoxTranscripts } from "./transcriptMirror.ts";
import {
  BoxApi,
  BoxRuntimeError,
  layer as boxApiLayer,
  type ManagedAgentHarness,
} from "./BoxApi.ts";
import { boxHarnessModels } from "./models.ts";
import {
  harnessCredentialKind,
  readBoxSecret,
  readGitHubToken,
  readHarnessCredentials,
} from "./credentials.ts";

const MODEL_VENDORS = { claudeCode: "Anthropic", codex: "OpenAI" } as const;

/**
 * Whether a Claude Code or Codex Box can start an agent run with the key it would be given.
 * Only a rejected key blocks the provider; the Box key itself already authenticated.
 */
const probeModelKey = Effect.fn("UpstashBox.probeModelKey")(function* (
  harness: ManagedAgentHarness,
  agentApiKey: string,
) {
  const vendor = MODEL_VENDORS[harness];
  const api = yield* BoxApi;
  return yield* Effect.tryPromise({
    try: () => api.checkModelKey(harness, agentApiKey),
    catch: () => new BoxRuntimeError({ operation: "checkModelKey" }),
  }).pipe(
    Effect.match({
      onSuccess: (statusCode) =>
        statusCode >= 200 && statusCode < 300
          ? ({ status: "ready", auth: { status: "authenticated" } } as const)
          : statusCode === 401 || statusCode === 403
            ? ({
                status: "error",
                auth: { status: "unauthenticated" },
                message: `${vendor} rejected the model API key.`,
              } as const)
            : ({
                status: "warning",
                auth: { status: "authenticated" },
                message: `Could not verify the model API key with ${vendor}.`,
              } as const),
      onFailure: () =>
        ({
          status: "warning",
          auth: { status: "authenticated" },
          message: `Could not verify the model API key with ${vendor}.`,
        }) as const,
    }),
  );
});

export const probe = Effect.fn("UpstashBox.probe")(function* (
  apiKey: string,
  agent: { readonly harness: BoxHarness; readonly agentApiKey: string },
) {
  const api = yield* BoxApi;
  if (!apiKey)
    return {
      status: "warning",
      auth: { status: "unauthenticated" },
      message: "Set the Upstash Box API key in environment settings or UPSTASH_BOX_API_KEY.",
    } as const;
  const kind = harnessCredentialKind(agent.harness, agent.agentApiKey);
  if (kind === undefined)
    return {
      status: "warning",
      auth: { status: "unauthenticated" },
      message: "Connect this harness in Settings → Providers.",
    } as const;
  const box = yield* Effect.tryPromise({
    try: () => api.list(apiKey),
    catch: (error) =>
      new BoxRuntimeError({
        operation: "list",
        ...(error instanceof BoxError && error.statusCode !== undefined
          ? { statusCode: error.statusCode }
          : {}),
      }),
  }).pipe(
    Effect.match({
      onSuccess: () => ({ status: "ready", auth: { status: "authenticated" } }) as const,
      onFailure: (error) =>
        ({
          status: "error",
          auth: {
            status:
              error.statusCode === 401 || error.statusCode === 403 ? "unauthenticated" : "unknown",
          },
          message: "Could not authenticate or connect to Upstash Box.",
        }) as const,
    }),
  );
  if (box.status !== "ready" || agent.harness === "commandCode" || kind !== "key") return box;
  return yield* probeModelKey(agent.harness, agent.agentApiKey);
});

export type UpstashBoxDriverEnv =
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | IdAllocatorV2
  | McpProviderSessions
  | Path.Path
  | ProviderHost;

type HarnessSettings = BoxCommandCodeSettings | BoxManagedAgentSettings;

function makeBoxHarnessDriver<Settings extends HarnessSettings>(
  harness: BoxHarness,
  settingsSchema: Schema.Codec<Settings, any>,
): ProviderDriver<Settings, UpstashBoxDriverEnv> {
  const driverKind = BOX_HARNESS_DRIVER_KINDS[harness];
  const label = BOX_HARNESS_LABELS[harness];
  const decodeSettings = Schema.decodeSync(settingsSchema);
  return {
    driverKind,
    metadata: { displayName: label, hasDefaultInstance: true },
    configSchema: settingsSchema,
    defaultConfig: () => decodeSettings({}),
    create: Effect.fn("UpstashBoxDriver.create")(function* (input) {
      const { instanceId, displayName, accentColor, enabled, config } = input;
      const host = yield* ProviderHost;
      const inheritedKey = yield* Config.String("UPSTASH_BOX_API_KEY").pipe(
        Config.withDefault(""),
        Effect.mapError(
          () =>
            new ProviderDriverError({
              driver: driverKind,
              instanceId,
              detail: "Could not read the Box API key environment variable.",
            }),
        ),
      );
      const envKey =
        input.environment.find((entry) => entry.name === "UPSTASH_BOX_API_KEY")?.value ??
        inheritedKey;
      // The Box is the thread's environment: its settings belong to the server, not this provider.
      const boxEnvironment = Effect.fn("UpstashBox.readEnvironment")(function* (
        settings: typeof DEFAULT_SERVER_SETTINGS,
      ) {
        const box = settings.upstashBox;
        const key = yield* readBoxSecret(box.apiKey, host.settings.resolveSecret);
        return {
          apiKey: box.apiKey === "" ? envKey : key,
          templateBoxName: box.templateBoxName,
          size: box.size,
          credentials: yield* readHarnessCredentials(box, host.settings.resolveSecret),
          githubToken: yield* readGitHubToken(settings, host.settings.resolveSecret),
        };
      });
      const environment: Effect.Effect<BoxEnvironmentConfig> = host.settings.get.pipe(
        Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS),
        Effect.flatMap(boxEnvironment),
      );
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const mirrorLock = yield* Semaphore.make(1);
      const transcriptMirrorDir = boxTranscriptMirrorDir(path, host.paths.stateDir, harness);
      const continuationIdentity = defaultProviderContinuationIdentity({ driverKind, instanceId });
      const agent = {
        driver: driverKind,
        harness,
        agentApiKey: "apiKey" in config ? settingsSecretLiteral(config.apiKey) : "",
      };
      const orchestrationAdapter = yield* makeUpstashBoxAdapter(
        instanceId,
        agent,
        environment,
        yield* McpProviderSessions,
        (box) =>
          mirrorBoxTranscripts(box, harness, transcriptMirrorDir).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.ignore,
            // Copies append from the mirrored size, so two at once would duplicate bytes.
            mirrorLock.withPermits(1),
          ),
      ).pipe(Effect.provide(boxApiLayer));
      const auth = host.settings.update
        ? yield* makeBoxHarnessAuth(instanceId, harness, environment, host.settings.update).pipe(
            Effect.provide(SecureRandom.layerWebCrypto),
          )
        : undefined;
      const base = Effect.gen(function* () {
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        return {
          instanceId,
          driver: driverKind,
          displayName: displayName || label,
          ...(accentColor ? { accentColor } : {}),
          continuation: { groupKey: continuationIdentity.continuationKey },
          enabled,
          installed: true,
          version: null,
          checkedAt,
          status: enabled ? "warning" : "disabled",
          auth: { status: "unknown" },
          supportsConversationRollback: false,
          supportsTextGeneration: false,
          supportedRuntimeModes: ["full-access"],
          showInteractionModeToggle: false,
          setup: { canAuthenticate: auth !== undefined, canInstall: false },
          models: providerModelsFromSettings(boxHarnessModels(harness), config.customModels, null),
          slashCommands: [],
          skills: [],
        } satisfies ServerProvider;
      });
      const toProbeSettings = ({ apiKey, credentials }: BoxEnvironmentConfig) => ({
        apiKey,
        agentApiKey: credentials?.[harness] || agent.agentApiKey,
      });
      // Claude Code and Codex in a Box have no plan-usage endpoint that their stored sign-in reaches.
      const readUsageLimits = (credential: string) =>
        harness === "commandCode"
          ? readCommandCodeUsageLimits(credential).pipe(
              Effect.provideService(HttpClient.HttpClient, httpClient),
            )
          : Effect.undefined;
      const snapshot = yield* makeManagedServerProvider({
        getSettings: environment.pipe(Effect.map(toProbeSettings)),
        streamSettings: host.settings.changes.pipe(
          Stream.mapEffect((settings) =>
            boxEnvironment(settings).pipe(Effect.map(toProbeSettings)),
          ),
        ),
        haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
        initialSnapshot: () => base,
        checkProvider: Effect.gen(function* () {
          const initial = yield* base;
          if (!enabled) return initial;
          const settings = toProbeSettings(yield* environment);
          const probed = yield* probe(settings.apiKey, {
            harness,
            agentApiKey: settings.agentApiKey,
          });
          const usageLimits =
            probed.status === "ready" ? yield* readUsageLimits(settings.agentApiKey) : undefined;
          return { ...initial, ...probed, ...(usageLimits ? { usageLimits } : {}) };
        }).pipe(Effect.provide(boxApiLayer)),
        ...(harness === "commandCode"
          ? {
              checkUsageLimits: environment.pipe(
                Effect.flatMap((settings) =>
                  readUsageLimits(toProbeSettings(settings).agentApiKey),
                ),
              ),
            }
          : {}),
        resolveMaintenance: () =>
          Effect.succeed({ provider: driverKind, packageName: null, update: null }),
      }).pipe(
        Effect.mapError(
          () =>
            new ProviderDriverError({
              driver: driverKind,
              instanceId,
              detail: `Could not initialize the ${label} provider snapshot.`,
            }),
        ),
      );
      const unsupported = (operation: string) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: `${label} in Upstash Box does not provide auxiliary text generation.`,
          }),
        );
      return {
        instanceId,
        driverKind,
        displayName,
        accentColor,
        enabled,
        continuationIdentity,
        snapshot,
        orchestrationAdapter,
        ...(auth ? { auth } : {}),
        textGeneration: {
          generateCommitMessage: () => unsupported("generateCommitMessage"),
          generatePrContent: () => unsupported("generatePrContent"),
          generateBranchName: () => unsupported("generateBranchName"),
          generateThreadTitle: () => unsupported("generateThreadTitle"),
          generateReviewGuide: () => unsupported("generateReviewGuide"),
          generateTranscriptionPostProcessing: () =>
            unsupported("generateTranscriptionPostProcessing"),
        },
      } satisfies ProviderInstance;
    }),
  };
}

export const BoxCommandCodeDriver = makeBoxHarnessDriver("commandCode", BoxCommandCodeSettings);
export const BoxClaudeCodeDriver = makeBoxHarnessDriver("claudeCode", BoxManagedAgentSettings);
export const BoxCodexDriver = makeBoxHarnessDriver("codex", BoxManagedAgentSettings);
