import {
  ProviderThreadId,
  type OrchestrationV2ProviderThread,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { BoxApi, BoxRuntimeError, isMissingBox, type BoxHandle, type BoxStream } from "./BoxApi.ts";
import { ensureBox, type BoxRuntimeConfig } from "./bootstrap.ts";
import { capabilities } from "./capabilities.ts";
import { BoxTurnTranslation, UPSTASH_BOX_PROVIDER as driver } from "./translation.ts";

interface ActiveTurn {
  stream?: BoxStream;
  translation: BoxTurnTranslation;
  interrupted: boolean;
}

export const makeUpstashBoxAdapter = Effect.fn("UpstashBox.makeAdapter")(function* (
  instanceId: ProviderInstanceId,
  config: BoxRuntimeConfig,
) {
  const ids = yield* IdAllocator.IdAllocatorV2;
  const api = yield* BoxApi;
  const unsupported = (operation: string) =>
    Effect.fail(
      new Adapter.ProviderAdapterProtocolError({
        driver,
        detail: `${operation} is not supported by Upstash Box`,
      }),
    );
  return Adapter.ProviderAdapterV2.of({
    instanceId,
    driver,
    deleteThread: Effect.fn("UpstashBox.deleteThread")(function* (thread) {
      const nativeId =
        thread.nativeThreadRef?.nativeId ??
        (thread.appThreadId ? `t3-${Buffer.from(thread.appThreadId).toString("hex")}` : undefined);
      if (!nativeId) return;
      yield* Effect.tryPromise({
        try: async () => {
          try {
            await (await api.get(nativeId, config.apiKey)).delete();
          } catch (error) {
            if (!isMissingBox(error)) throw error;
          }
        },
        catch: () =>
          new Adapter.ProviderAdapterProtocolError({
            driver,
            detail: "Could not delete the thread Box.",
          }),
      });
    }),
    getCapabilities: Effect.fn("UpstashBox.getCapabilities")(() => Effect.succeed(capabilities)),
    planSelectionTransition: Effect.fn("UpstashBox.planSelectionTransition")((input) =>
      Effect.succeed(
        input.current.model === input.target.model
          ? { type: "apply_on_next_turn" }
          : { type: "reject", reason: "The Command Code model is fixed when the Box is created." },
      ),
    ),
    openSession: Effect.fn("UpstashBox.openSession")(function* (input) {
      const scope = yield* Effect.scope;
      const events = yield* Queue.unbounded<Adapter.ProviderAdapterV2Event>();
      const boxes = new Map<string, BoxHandle>();
      const threads = new Map<ProviderThreadId, OrchestrationV2ProviderThread>();
      let active: ActiveTurn | undefined;
      const now = yield* DateTime.now;
      const providerSession = {
        id: input.providerSessionId,
        driver,
        providerInstanceId: instanceId,
        status: "ready" as const,
        cwd: "/workspace/home",
        model: config.model || null,
        capabilities,
        extensionStatuses: [],
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const publish = (batch: ReadonlyArray<Adapter.ProviderAdapterV2Event>) =>
        Queue.offerAll(events, batch).pipe(Effect.asVoid);
      const saveThread = Effect.fn("UpstashBox.saveThread")(function* (
        thread: OrchestrationV2ProviderThread,
        box: BoxHandle,
      ) {
        boxes.set(box.id, box);
        threads.set(thread.id, thread);
        yield* publish([{ type: "provider_thread.updated", driver, providerThread: thread }]);
        return thread;
      });
      const runtime: Adapter.ProviderAdapterV2SessionRuntime = {
        instanceId,
        driver,
        providerSessionId: input.providerSessionId,
        providerSession,
        events: Stream.fromEffectRepeat(Queue.take(events)),
        ensureThread: Effect.fn("UpstashBox.ensureThread")(function* (request) {
          if (request.existingProviderThread?.nativeThreadRef?.nativeId)
            return yield* runtime.resumeThread({ providerThread: request.existingProviderThread });
          // Hex encoding is injective, shell-safe, and stable across server restarts.
          const name = `t3-${Buffer.from(request.threadId).toString("hex")}`;
          const box = yield* ensureBox(config, name, request.runtimePolicy.repositoryUrl).pipe(
            Effect.provideService(BoxApi, api),
            Effect.mapError(
              () =>
                new Adapter.ProviderAdapterEnsureThreadError({
                  driver,
                  threadId: request.threadId,
                }),
            ),
          );
          const at = yield* DateTime.now;
          const thread: OrchestrationV2ProviderThread = {
            id: ProviderThreadId.make(box.id),
            driver,
            providerInstanceId: instanceId,
            providerSessionId: input.providerSessionId,
            appThreadId: request.threadId,
            ownerNodeId: null,
            nativeThreadRef: { driver, nativeId: box.id, strength: "strong" },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [],
            contextUsage: null,
            nativeMetadata: null,
            goal: null,
            createdAt: at,
            updatedAt: at,
          };
          return yield* saveThread(thread, box);
        }),
        resumeThread: Effect.fn("UpstashBox.resumeThread")(function* (request) {
          const previous = request.providerThread;
          const nativeId = previous.nativeThreadRef?.nativeId;
          if (!nativeId) return yield* unsupported("Resuming a thread without a Box identity");
          const box = yield* Effect.tryPromise({
            try: async () => {
              try {
                return await api.get(nativeId, config.apiKey);
              } catch (error) {
                if (!isMissingBox(error)) throw new BoxRuntimeError({ operation: "get" });
                return null;
              }
            },
            catch: () =>
              new Adapter.ProviderAdapterResumeThreadError({
                driver,
                providerSessionId: input.providerSessionId,
                providerThreadId: previous.id,
              }),
          });
          if (!box) {
            const threadId = request.threadId ?? previous.appThreadId;
            if (!threadId)
              return yield* unsupported("Recreating a Box without an app thread identity");
            return yield* runtime.ensureThread({
              threadId,
              runtimePolicy: input.runtimePolicy,
              modelSelection: input.modelSelection,
            });
          }
          return yield* saveThread(
            {
              ...previous,
              providerSessionId: input.providerSessionId,
              status: "idle",
              updatedAt: yield* DateTime.now,
            },
            box,
          );
        }),
        startTurn: Effect.fn("UpstashBox.startTurn")(function* (request) {
          if (active)
            return yield* new Adapter.ProviderAdapterProtocolError({
              driver,
              detail: "A Box turn is already active",
              reason: "previous_turn_active",
            });
          if (request.message.attachments.length || request.resume || request.appContext?.length)
            return yield* unsupported("Attachments, native resume, and application context");
          if (request.runtimePolicy.runtimeMode !== "full-access")
            return yield* unsupported("Restricted runtime policies");
          const box = boxes.get(request.providerThread.nativeThreadRef?.nativeId ?? "");
          if (!box) return yield* new Adapter.ProviderAdapterSessionStoppedError({ driver });
          const translation = new BoxTurnTranslation(request, ids.derive, yield* DateTime.now);
          const turn: ActiveTurn = { translation, interrupted: false };
          active = turn;
          yield* publish(translation.start(yield* DateTime.now));
          const process = Effect.gen(function* () {
            // Box supplies the prior finish.sessionId to its custom harness as --session.
            const stream = yield* Effect.tryPromise({
              try: () => box.agent.stream({ prompt: request.message.text }),
              catch: () => new BoxRuntimeError({ operation: "stream" }),
            });
            turn.stream = stream;
            if (turn.interrupted)
              yield* Effect.tryPromise({
                try: () => stream.cancel(),
                catch: () => new BoxRuntimeError({ operation: "cancel" }),
              });
            yield* Stream.fromAsyncIterable(
              stream,
              () => new BoxRuntimeError({ operation: "stream" }),
            ).pipe(
              Stream.runForEach((chunk) =>
                Effect.gen(function* () {
                  yield* publish(translation.accept(chunk, yield* DateTime.now));
                }),
              ),
            );
          });
          yield* process.pipe(
            Effect.isFailure,
            Effect.flatMap(
              Effect.fn("UpstashBox.finishTurn")(function* (failed) {
                if (translation.sessionId) {
                  const thread = threads.get(request.providerThread.id) ?? request.providerThread;
                  yield* saveThread(
                    {
                      ...thread,
                      nativeConversationHeadRef: {
                        driver,
                        nativeId: translation.sessionId,
                        strength: "strong",
                      },
                      updatedAt: yield* DateTime.now,
                    },
                    box,
                  );
                }
                active = undefined;
                yield* publish(translation.complete(yield* DateTime.now, turn.interrupted, failed));
              }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                if (active === turn) active = undefined;
              }),
            ),
            Effect.forkIn(scope),
          );
        }),
        interruptTurn: Effect.fn("UpstashBox.interruptTurn")(function* (request) {
          if (!active || active.translation.providerTurnId !== request.providerTurnId) return;
          active.interrupted = true;
          const stream = active.stream;
          if (stream)
            yield* Effect.tryPromise({
              try: () => stream.cancel(),
              catch: () =>
                new Adapter.ProviderAdapterInterruptError({
                  driver,
                  providerThreadId: request.providerThread.id,
                  providerTurnId: request.providerTurnId,
                }),
            });
        }),
        steerTurn: (request) =>
          Effect.fail(
            new Adapter.ProviderAdapterSteerRunUnsupportedError({
              driver,
              providerThreadId: request.providerThread.id,
            }),
          ),
        readThreadSnapshot: () => unsupported("Reading a conversation snapshot"),
        rollbackThread: () => unsupported("Rollback"),
        forkThread: () => unsupported("Fork"),
        respondToRuntimeRequest: () => unsupported("Runtime requests"),
      };
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const stream = active?.stream;
          if (stream) yield* Effect.promise(() => stream.cancel()).pipe(Effect.ignore);
          yield* Queue.shutdown(events);
        }),
      );
      return runtime;
    }),
  });
});
