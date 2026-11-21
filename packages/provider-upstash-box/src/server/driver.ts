import {
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
import type { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
} from "@t3tools/provider-core/server/snapshotSettings";
import { BoxError } from "@upstash/box";
import * as DateTime from "effect/DateTime";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { UpstashBoxSettings } from "../settings.ts";
import { makeUpstashBoxAdapter } from "./adapter.ts";
import { BoxApi, BoxRuntimeError, layer as boxApiLayer } from "./BoxApi.ts";
import { UPSTASH_BOX_PROVIDER as driverKind } from "./translation.ts";

export const probe = Effect.fn("UpstashBox.probe")(function* (apiKey: string) {
  const api = yield* BoxApi;
  if (!apiKey)
    return {
      status: "warning",
      auth: { status: "unauthenticated" },
      message: "Set an API key or UPSTASH_BOX_API_KEY.",
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
const decodeSettings = Schema.decodeSync(UpstashBoxSettings);

export const UpstashBoxDriver: ProviderDriver<UpstashBoxSettings, UpstashBoxDriverEnv> = {
  driverKind,
  metadata: { displayName: "Upstash Box", hasDefaultInstance: true },
  configSchema: UpstashBoxSettings,
  defaultConfig: () => decodeSettings({}),
  create: Effect.fn("UpstashBoxDriver.create")(function* (input) {
    const { instanceId, displayName, accentColor, enabled, config } = input;
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
    const apiKey = settingsSecretLiteral(config.apiKey) || envKey;
    const continuationIdentity = defaultProviderContinuationIdentity({ driverKind, instanceId });
    const orchestrationAdapter = yield* makeUpstashBoxAdapter(instanceId, {
      ...config,
      apiKey,
    }).pipe(Effect.provide(boxApiLayer));
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
        models: [
          {
            slug: config.model || "default",
            name: config.model || "Command Code (template default)",
            isCustom: false,
            isDefault: true,
            supportsTextGeneration: false,
            capabilities: null,
          },
        ],
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
        return enabled ? { ...initial, ...(yield* probe(apiKey)) } : initial;
      }).pipe(Effect.provide(boxApiLayer)),
      resolveMaintenance: () =>
        Effect.succeed({ provider: driverKind, packageName: null, update: null }),
    }).pipe(
      Effect.mapError(
        () =>
          new ProviderDriverError({
            driver: driverKind,
            instanceId,
            detail: "Could not initialize the Box provider snapshot.",
          }),
      ),
    );
    const unsupported = (operation: string) =>
      Effect.fail(
        new TextGenerationError({
          operation,
          detail: "Upstash Box does not provide auxiliary text generation.",
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
