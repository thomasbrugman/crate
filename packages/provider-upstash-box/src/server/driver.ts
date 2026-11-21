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
import { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import { providerModelsFromSettings } from "@t3tools/provider-core/server/snapshotProbe";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
} from "@t3tools/provider-core/server/snapshotSettings";
import { BoxError } from "@upstash/box";
import * as DateTime from "effect/DateTime";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { BOX_HARNESS_DRIVER_KINDS, BOX_HARNESS_LABELS, type BoxHarness } from "../harnesses.ts";
import { BoxCommandCodeSettings, BoxManagedAgentSettings } from "../settings.ts";
import { makeUpstashBoxAdapter, type BoxEnvironmentConfig } from "./adapter.ts";
import { BoxApi, BoxRuntimeError, layer as boxApiLayer } from "./BoxApi.ts";
import { boxHarnessModels } from "./models.ts";

export const probe = Effect.fn("UpstashBox.probe")(function* (apiKey: string) {
  const api = yield* BoxApi;
  if (!apiKey)
    return {
      status: "warning",
      auth: { status: "unauthenticated" },
      message: "Set the Upstash Box API key in environment settings or UPSTASH_BOX_API_KEY.",
    } as const;
  return yield* Effect.tryPromise({
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
});

export type UpstashBoxDriverEnv = IdAllocatorV2 | ProviderHost;

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
      const environment: Effect.Effect<BoxEnvironmentConfig> = host.settings.get.pipe(
        Effect.map((settings) => settings.upstashBox),
        Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS.upstashBox),
        Effect.map((box) => ({
          apiKey: settingsSecretLiteral(box.apiKey) || envKey,
          templateBoxName: box.templateBoxName,
          size: box.size,
        })),
      );
      const continuationIdentity = defaultProviderContinuationIdentity({ driverKind, instanceId });
      const orchestrationAdapter = yield* makeUpstashBoxAdapter(
        instanceId,
        {
          driver: driverKind,
          harness,
          agentApiKey: "apiKey" in config ? settingsSecretLiteral(config.apiKey) : "",
        },
        environment,
      ).pipe(Effect.provide(boxApiLayer));
      const base = Effect.gen(function* () {
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        return {
          instanceId,
          driver: driverKind,
          ...(displayName ? { displayName } : {}),
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
          setup: { canAuthenticate: false, canInstall: false },
          models: providerModelsFromSettings(boxHarnessModels(harness), config.customModels, null),
          slashCommands: [],
          skills: [],
        } satisfies ServerProvider;
      });
      const source = yield* makeProviderSnapshotSettingsSource(config);
      const snapshot = yield* makeManagedServerProvider({
        ...source,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: () => base,
        checkProvider: Effect.gen(function* () {
          const initial = yield* base;
          if (!enabled) return initial;
          return { ...initial, ...(yield* probe((yield* environment).apiKey)) };
        }).pipe(Effect.provide(boxApiLayer)),
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
