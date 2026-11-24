import {
  isSecretReference,
  SettingsSecretValue,
  ThreadId,
  ProviderThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import { BoxApi, mirrorEveryBoxTranscript } from "@t3tools/provider-upstash-box/server";
import { boxNameForThread, isBoxWorkerDriver } from "@t3tools/provider-upstash-box/harnesses";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";

export class BoxThreadCleanupError extends Schema.TaggedError<BoxThreadCleanupError>()(
  "BoxThreadCleanupError",
  {
    threadId: ThreadId,
    providerThreadId: Schema.optional(ProviderThreadId),
    boxError: Schema.optional(BoxApi.BoxErrorDetails),
    cause: Schema.optional(BoxApi.BoxErrorDetails),
    reason: Schema.Literals([
      "load_failed",
      "invalid_reference",
      "credentials_unavailable",
      "delete_failed",
    ]),
  },
) {
  override get message(): string {
    return `Could not delete the thread Box (${this.reason}).${this.boxError ? ` ${this.boxError.message}` : ""}`;
  }
}

const isBoxThreadCleanupError = Schema.is(BoxThreadCleanupError);

export class BoxThreadCleanup extends Context.Service<
  BoxThreadCleanup,
  {
    readonly remove: (input: {
      readonly threadId: ThreadId;
      readonly providerThread: OrchestrationV2ProviderThread;
    }) => Effect.Effect<void, BoxThreadCleanupError>;
  }
>()("t3/orchestration-v2/BoxThreadCleanup") {}

const decodeLegacySettings = Schema.decodeUnknownEffect(
  Schema.Struct({
    apiKey: SettingsSecretValue.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  }),
);

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const api = yield* BoxApi.BoxApi;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Usage history reads host copies of the transcripts, so take the last copy before deleting.
  const mirrorTranscripts = (box: BoxApi.BoxHandle) =>
    mirrorEveryBoxTranscript(box, config.stateDir).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  const readSecret = (value: SettingsSecretValue, threadId: ThreadId) =>
    isSecretReference(value)
      ? secrets
          .read([value])
          .pipe(
            Effect.flatMap((values) =>
              values[0]
                ? Effect.succeed(values[0])
                : Effect.fail(
                    new BoxThreadCleanupError({ threadId, reason: "credentials_unavailable" }),
                  ),
            ),
          )
      : Effect.succeed(value);
  return BoxThreadCleanup.of({
    remove: Effect.fn("BoxThreadCleanup.remove")(function* ({ threadId, providerThread: thread }) {
      const failure = (reason: BoxThreadCleanupError["reason"]) =>
        new BoxThreadCleanupError({ threadId, providerThreadId: thread.id, reason });
      const nativeRef = thread.nativeThreadRef;
      if (nativeRef !== null && (nativeRef.driver !== thread.driver || !nativeRef.nativeId))
        return yield* failure("invalid_reference");
      const nativeId = isBoxWorkerDriver(thread.driver)
        ? boxNameForThread(threadId)
        : (nativeRef?.nativeId ??
          (thread.appThreadId
            ? `t3-${Buffer.from(thread.appThreadId).toString("hex")}`
            : undefined));
      if (!nativeId) return yield* failure("invalid_reference");
      const apiKey = yield* Effect.gen(function* () {
        const current = yield* settings.getSettings.pipe(
          Effect.mapError(
            (cause) =>
              new BoxThreadCleanupError({
                threadId,
                providerThreadId: thread.id,
                reason: "credentials_unavailable",
                cause: { message: cause.message },
              }),
          ),
        );
        const instance = deriveProviderInstanceConfigMap(current)[thread.providerInstanceId];
        const configured = instance?.driver === thread.driver ? instance : undefined;
        const globalKey = yield* readSecret(current.upstashBox.apiKey, threadId);
        if (globalKey) return globalKey;
        if (thread.driver === "upstashBox" && configured?.driver === thread.driver) {
          const legacy = yield* decodeLegacySettings(configured.config ?? {});
          const legacyKey = yield* readSecret(legacy.apiKey, threadId);
          if (legacyKey) return legacyKey;
        }
        const environmentValue = configured?.environment?.find(
          (entry) => entry.name === "UPSTASH_BOX_API_KEY",
        )?.value;
        return environmentValue === undefined
          ? yield* Config.String("UPSTASH_BOX_API_KEY").pipe(Config.withDefault(""))
          : yield* readSecret(environmentValue, threadId);
      }).pipe(
        Effect.mapError((cause) =>
          isBoxThreadCleanupError(cause) && cause.cause
            ? cause
            : failure("credentials_unavailable"),
        ),
      );
      if (!apiKey) return yield* failure("credentials_unavailable");
      const deleteFailed = (error: unknown) =>
        new BoxThreadCleanupError({
          threadId,
          providerThreadId: thread.id,
          reason: "delete_failed",
          boxError: BoxApi.boxErrorDetails(error, { boxId: nativeId }),
        });
      const box = yield* Effect.tryPromise({
        try: async () => {
          try {
            return await api.get(nativeId, apiKey);
          } catch (error) {
            if (!BoxApi.isMissingBox(error)) throw error;
            return undefined;
          }
        },
        catch: deleteFailed,
      });
      if (box === undefined) return;
      yield* mirrorTranscripts(box);
      yield* Effect.tryPromise({
        try: async () => {
          try {
            await box.delete();
          } catch (error) {
            if (!BoxApi.isMissingBox(error)) throw error;
          }
        },
        catch: deleteFailed,
      });
    }),
  });
});

export const layer = Layer.effect(BoxThreadCleanup, make);
