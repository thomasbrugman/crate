import {
  isSecretReference,
  SettingsSecretValue,
  type ThreadId,
  GitCommandError,
} from "@t3tools/contracts";
import { BoxApi, BoxExec } from "@t3tools/provider-upstash-box/server";
import { isUpstashBoxDriver } from "@t3tools/provider-upstash-box/harnesses";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BoxGitHost from "./BoxGitHost.ts";
import * as VcsThreadTarget from "./VcsThreadTarget.ts";

const decodeLegacySettings = Schema.decodeUnknownEffect(
  Schema.Struct({
    apiKey: SettingsSecretValue.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  }),
);
const isBoxExecError = Schema.is(BoxExec.BoxExecError);

export class BoxThreadResolver extends Context.Service<
  BoxThreadResolver,
  {
    readonly resolve: (
      threadId: ThreadId,
    ) => Effect.Effect<VcsThreadTarget.Target, BoxExec.BoxExecError>;
  }
>()("t3/vcs/BoxThreadResolver") {}

/** @public */
export const make = Effect.gen(function* () {
  const projection = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const api = yield* BoxApi.BoxApi;
  const repositories = new Map<string, string | null>();
  const readSecret = (value: SettingsSecretValue, threadId: ThreadId) =>
    isSecretReference(value)
      ? secrets
          .read([value])
          .pipe(
            Effect.flatMap((values) =>
              values[0]
                ? Effect.succeed(values[0])
                : Effect.fail(new BoxExec.BoxExecError({ threadId, reason: "resolve_failed" })),
            ),
          )
      : Effect.succeed(value);
  const resolve = Effect.fn("BoxThreadResolver.resolve")(
    function* (threadId: ThreadId) {
      const context = yield* projection.getThreadRecords(threadId, ["providerThreads"]);
      if (context.thread.deletedAt !== null) return null;
      const providerThread = context.providerThreads.find(
        (thread) => thread.id === context.thread.activeProviderThreadId,
      );
      if (
        !providerThread ||
        (!isUpstashBoxDriver(providerThread.driver) && providerThread.driver !== "upstashBox") ||
        providerThread.nativeThreadRef?.driver !== providerThread.driver ||
        !providerThread.nativeThreadRef?.nativeId
      )
        return null;
      const project = yield* projects.get(context.thread.projectId);
      if (Option.isNone(project) || project.value.deletedAt !== null) return null;
      const serverSettings = yield* settings.getSettings;
      const configured =
        deriveProviderInstanceConfigMap(serverSettings)[providerThread.providerInstanceId];
      if (!configured || configured.driver !== providerThread.driver) return null;
      const environmentKey = yield* readSecret(serverSettings.upstashBox.apiKey, threadId);
      const configuredKey =
        environmentKey ||
        (providerThread.driver === "upstashBox"
          ? yield* decodeLegacySettings(configured.config ?? {}).pipe(
              Effect.flatMap((config) => readSecret(config.apiKey, threadId)),
            )
          : "");
      const envValue = configured.environment?.find(
        (entry) => entry.name === "UPSTASH_BOX_API_KEY",
      )?.value;
      const apiKey =
        configuredKey ||
        (envValue === undefined
          ? yield* Config.String("UPSTASH_BOX_API_KEY").pipe(Config.withDefault(""))
          : yield* readSecret(envValue, threadId));
      if (!apiKey) return null;
      const nativeId = providerThread.nativeThreadRef.nativeId;
      if (!repositories.has(nativeId)) {
        const unavailable = () => new BoxExec.BoxExecError({ threadId, reason: "box_unavailable" });
        const box = yield* Effect.tryPromise({
          try: () => api.get(nativeId, apiKey),
          catch: unavailable,
        });
        const checkout = yield* Effect.tryPromise({
          try: () =>
            box.exec.command(
              "if test -d /workspace/home/repo; then git -C /workspace/home/repo config --get remote.origin.url || printf '%s' box-checkout; fi",
            ),
          catch: unavailable,
        });
        if (checkout.exitCode !== 0) return null;
        repositories.set(nativeId, checkout.stdout.trim() || null);
      }
      const checkoutRoot = !repositories.get(nativeId)
        ? BoxApi.BOX_WORKSPACE_PATH
        : providerThread.nativeMetadata?.boxOwnerThreadId
          ? BoxApi.boxWorktreePath(threadId)
          : BoxApi.BOX_REPOSITORY_PATH;
      return {
        providerThread,
        apiKey,
        checkoutRoot,
        projectRoot: project.value.workspaceRoot,
      };
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isBoxExecError(cause)
            ? new BoxExec.BoxExecError({ threadId, reason: cause.reason })
            : new BoxExec.BoxExecError({ threadId, reason: "resolve_failed" }),
        ),
      ),
  );
  return {
    exec: BoxExec.BoxExecThreadResolver.of({ resolve }),
    target: BoxThreadResolver.of({
      resolve: Effect.fn("BoxThreadResolver.target")((threadId) =>
        resolve(threadId).pipe(
          Effect.filterOrFail(
            (value) => value !== null,
            () => new BoxExec.BoxExecError({ threadId, reason: "thread_unavailable" }),
          ),
          Effect.map((value) => ({
            threadId,
            projectRoot: value.projectRoot,
            checkoutRoot: value.checkoutRoot,
          })),
        ),
      ),
    }),
  };
});

export const layer = Layer.effectContext(
  make.pipe(
    Effect.map(({ exec, target }) =>
      Context.make(BoxExec.BoxExecThreadResolver, exec).pipe(
        Context.add(BoxThreadResolver, target),
      ),
    ),
  ),
).pipe(Layer.provide(BoxApi.layer));

export const withTarget = <A, E, R>(
  input: { readonly threadId?: ThreadId | undefined; readonly cwd: string },
  effect: Effect.Effect<A, E, R>,
) =>
  input.threadId === undefined
    ? effect
    : Effect.gen(function* () {
        const resolver = yield* BoxThreadResolver;
        const target = yield* resolver.resolve(input.threadId!).pipe(
          Effect.mapError(
            () =>
              new GitCommandError({
                operation: "Git.Box",
                cwd: input.cwd,
                command: "git",
                detail: "Box unavailable for this thread.",
              }),
          ),
        );
        if (BoxGitHost.mapPath(target, input.cwd) === undefined)
          return yield* new GitCommandError({
            operation: "Git.Box",
            cwd: input.cwd,
            command: "git",
            detail: "Git path is outside the thread's project root.",
          });
        return yield* effect.pipe(Effect.provideService(VcsThreadTarget.VcsThreadTarget, target));
      });

export const withTargetStream = <A, E, R>(
  input: { readonly threadId?: ThreadId | undefined; readonly cwd: string },
  stream: Stream.Stream<A, E, R>,
) =>
  Stream.unwrap(
    withTarget(
      input,
      Effect.context<R>().pipe(Effect.map((context) => Stream.provideContext(stream, context))),
    ),
  );
