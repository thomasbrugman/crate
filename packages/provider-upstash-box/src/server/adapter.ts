import {
  ProviderThreadId,
  ProviderSetupError,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { BoxError } from "@upstash/box";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { BOX_HARNESS_LABELS, type BoxHarness } from "../harnesses.ts";
import {
  BOX_REPOSITORY_PATH,
  BOX_WORKSPACE_PATH,
  BoxApi,
  BoxRuntimeError,
  isMissingBox,
  type BoxHandle,
  type BoxStream,
} from "./BoxApi.ts";
import { ensureBox, type BoxRuntimeConfig, type BoxSetupStep } from "./bootstrap.ts";
import { capabilities } from "./capabilities.ts";
import { commandCodeHarness } from "./harness.ts";
import { cancelBoxRun } from "./stop.ts";
import { BoxTurnTranslation } from "./translation.ts";

/** Where a thread runs, read from the environment's settings each time a Box is reached. */
export type BoxEnvironmentConfig = Pick<BoxRuntimeConfig, "apiKey" | "templateBoxName" | "size">;

/** Which agent runs inside the thread's Box. */
export interface BoxAgentConfig {
  readonly driver: ProviderDriverKind;
  readonly harness: BoxHarness;
  readonly agentApiKey: string;
}

interface ActiveTurn {
  box: BoxHandle;
  runMarker: string;
  stream?: BoxStream;
  translation: BoxTurnTranslation;
  interrupted: boolean;
}

// Exits 0 only when the Box holds nothing a fresh clone would lose: no uncommitted or
// untracked or ignored files, stashes, commits missing from the remote, or files beside the repository.
// Every Box starts with the agent configuration directories below in its workspace.
const SAVED_WORK_CHECK = [
  "cd /workspace/home && entries=$(ls -A) &&",
  'extra=$(printf "%s\\n" "$entries" | grep -vxF -e repo -e .claude -e .codex -e .cursor -e .local || true) &&',
  'test -z "$extra" && { test ! -e repo || { cd repo && test -d .git &&',
  'status=$(git -c status.showUntrackedFiles=all status --porcelain --ignored) && test -z "$status" &&',
  'stash=$(git stash list) && test -z "$stash" &&',
  'unpushed=$(git rev-list --count HEAD --branches --not --remotes) && test "$unpushed" = 0; }; }',
].join(" ");

const SETUP_STEP_TEXT: Record<BoxSetupStep, string> = {
  connect: "Connecting to the Box",
  create: "Creating the Box",
  check: "Checking the Box setup",
  install: "Installing Command Code",
  credentials: "Copying credentials from the template Box",
  clone: "Cloning the repository",
};

const boxStoppedMessage = "This thread's Box stopped mid-turn. Send a message to start a new one.";

export const makeUpstashBoxAdapter = Effect.fn("UpstashBox.makeAdapter")(function* (
  instanceId: ProviderInstanceId,
  agent: BoxAgentConfig,
  environment: Effect.Effect<BoxEnvironmentConfig>,
) {
  const { driver, harness } = agent;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const api = yield* BoxApi;
  const authenticationCause = (error: BoxRuntimeError, apiKey: string) => {
    const detail = !apiKey.trim()
      ? "Upstash Box API key is missing. Add it in Settings → Providers."
      : error.statusCode === 401 || error.statusCode === 403
        ? "Upstash Box rejected the API key. Check it in Settings → Providers."
        : undefined;
    return detail === undefined
      ? undefined
      : new ProviderSetupError({ instanceId, operation: "authenticate", detail });
  };
  const unsupported = (operation: string) =>
    Effect.fail(
      new Adapter.ProviderAdapterProtocolError({
        driver,
        detail: `${operation} is not supported by ${BOX_HARNESS_LABELS[harness]} in Upstash Box`,
      }),
    );
  const removeBox = (thread: OrchestrationV2ProviderThread, keepUnsavedWork: boolean) => {
    const nativeId =
      thread.nativeThreadRef?.nativeId ??
      (thread.appThreadId ? `t3-${Buffer.from(thread.appThreadId).toString("hex")}` : undefined);
    return Effect.flatMap(environment, ({ apiKey }) =>
      Effect.tryPromise({
        try: async () => {
          if (!nativeId) return true;
          try {
            const box = await api.get(nativeId, apiKey);
            if (keepUnsavedWork && (await box.exec.command(SAVED_WORK_CHECK)).exitCode !== 0)
              return false;
            await box.delete();
          } catch (error) {
            if (!isMissingBox(error)) throw error;
          }
          return true;
        },
        catch: () =>
          new Adapter.ProviderAdapterProtocolError({
            driver,
            detail: "Could not delete the thread Box.",
          }),
      }),
    );
  };
  return Adapter.ProviderAdapterV2.of({
    instanceId,
    driver,
    deleteThread: Effect.fn("UpstashBox.deleteThread")(function* (thread) {
      yield* removeBox(thread, false);
    }),
    deleteIdleThread: Effect.fn("UpstashBox.deleteIdleThread")((thread) => removeBox(thread, true)),
    getCapabilities: Effect.fn("UpstashBox.getCapabilities")(() => Effect.succeed(capabilities)),
    planSelectionTransition: Effect.fn("UpstashBox.planSelectionTransition")((input) =>
      Effect.succeed(
        input.current.model === input.target.model
          ? { type: "apply_on_next_turn" }
          : {
              type: "reject",
              reason: `The ${BOX_HARNESS_LABELS[harness]} model is fixed when the Box is created.`,
            },
      ),
    ),
    openSession: Effect.fn("UpstashBox.openSession")(function* (input) {
      const scope = yield* Effect.scope;
      const events = yield* Queue.unbounded<Adapter.ProviderAdapterV2Event>();
      const boxes = new Map<string, BoxHandle>();
      const recreatedThreads = new Set<ProviderThreadId>();
      let active: ActiveTurn | undefined;
      const now = yield* DateTime.now;
      let providerSession: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver,
        providerInstanceId: instanceId,
        status: "ready" as const,
        cwd: BOX_WORKSPACE_PATH,
        model: input.modelSelection?.model ?? null,
        capabilities,
        extensionStatuses: [],
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const publish = (batch: ReadonlyArray<Adapter.ProviderAdapterV2Event>) =>
        Queue.offerAll(events, batch).pipe(Effect.asVoid);
      const setSessionStatus = Effect.fn("UpstashBox.setSessionStatus")(function* (
        status: OrchestrationV2ProviderSession["status"],
      ) {
        providerSession = {
          ...providerSession,
          status,
          extensionStatuses: [],
          updatedAt: yield* DateTime.now,
        };
        yield* publish([{ type: "provider_session.updated", driver, providerSession }]);
      });
      // Called from inside the bootstrap promise, so it publishes synchronously. Clients
      // translate by key; the text is the English fallback.
      const showSetupStep = (step: BoxSetupStep) => {
        providerSession = {
          ...providerSession,
          extensionStatuses: [{ key: `upstash-box.setup.${step}`, text: SETUP_STEP_TEXT[step] }],
          updatedAt: DateTime.nowUnsafe(),
        };
        Queue.offerUnsafe(events, { type: "provider_session.updated", driver, providerSession });
      };
      const saveThread = Effect.fn("UpstashBox.saveThread")(function* (
        thread: OrchestrationV2ProviderThread,
        box: BoxHandle,
      ) {
        boxes.set(box.id, box);
        yield* publish([{ type: "provider_thread.updated", driver, providerThread: thread }]);
        return thread;
      });
      const runtime: Adapter.ProviderAdapterV2SessionRuntime = {
        instanceId,
        driver,
        providerSessionId: input.providerSessionId,
        revalidateLoadedThreads: true,
        get providerSession() {
          return providerSession;
        },
        events: Stream.fromEffectRepeat(Queue.take(events)),
        ensureThread: Effect.fn("UpstashBox.ensureThread")(function* (request) {
          if (request.existingProviderThread?.nativeThreadRef?.nativeId)
            return yield* runtime.resumeThread({
              providerThread: request.existingProviderThread,
              runtimePolicy: request.runtimePolicy,
            });
          // Hex encoding is injective, shell-safe, and stable across server restarts.
          const name = `t3-${Buffer.from(request.threadId).toString("hex")}`;
          const config: BoxRuntimeConfig = {
            ...(yield* environment),
            harness,
            model: request.modelSelection.model,
            agentApiKey: agent.agentApiKey,
          };
          yield* setSessionStatus("starting");
          const box = yield* ensureBox(
            { ...config, size: request.runtimePolicy.boxSize ?? config.size },
            name,
            request.runtimePolicy.repositoryUrl,
            showSetupStep,
          ).pipe(
            Effect.provideService(BoxApi, api),
            Effect.tapError(() => setSessionStatus("error")),
            Effect.mapError((error) =>
              error.missingStoredKey
                ? new Adapter.ProviderAdapterProtocolError({
                    driver,
                    detail: `Your Upstash account has no stored model key for ${BOX_HARNESS_LABELS[harness]}. Set a model API key in its provider settings`,
                  })
                : new Adapter.ProviderAdapterEnsureThreadError({
                    driver,
                    threadId: request.threadId,
                    cause: authenticationCause(error, config.apiKey),
                  }),
            ),
          );
          yield* setSessionStatus("ready");
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
          const runtimePolicy = request.runtimePolicy ?? input.runtimePolicy;
          const config: BoxRuntimeConfig = {
            ...(yield* environment),
            harness,
            model: request.modelSelection?.model ?? input.modelSelection.model,
            agentApiKey: agent.agentApiKey,
          };
          const box = yield* Effect.tryPromise({
            try: async () => {
              try {
                if (!config.apiKey.trim()) throw new BoxRuntimeError({ operation: "get" });
                const existing = await api.get(nativeId, config.apiKey);
                // Lookup by ID also returns deleted Box tombstones; status does not.
                await existing.getStatus();
                if (harness === "commandCode") {
                  await existing.files.write({
                    path: "/home/boxuser/.local/bin/t3stash-harness.mjs",
                    content: commandCodeHarness,
                  });
                }
                return existing;
              } catch (error) {
                if (!isMissingBox(error)) throw error;
                return null;
              }
            },
            catch: (error) =>
              new Adapter.ProviderAdapterResumeThreadError({
                driver,
                providerSessionId: input.providerSessionId,
                providerThreadId: previous.id,
                cause: authenticationCause(
                  new BoxRuntimeError({
                    operation: "get",
                    ...(error instanceof BoxError && error.statusCode !== undefined
                      ? { statusCode: error.statusCode }
                      : {}),
                  }),
                  config.apiKey,
                ),
              }),
          });
          if (!box) {
            const threadId = request.threadId ?? previous.appThreadId;
            if (!threadId)
              return yield* unsupported("Recreating a Box without an app thread identity");
            yield* setSessionStatus("starting");
            const replacement = yield* ensureBox(
              { ...config, size: runtimePolicy.boxSize ?? config.size },
              `t3-${Buffer.from(threadId).toString("hex")}`,
              runtimePolicy.repositoryUrl,
              showSetupStep,
            ).pipe(
              Effect.provideService(BoxApi, api),
              Effect.tapError(() => setSessionStatus("error")),
              Effect.mapError(
                (error) =>
                  new Adapter.ProviderAdapterEnsureThreadError({
                    driver,
                    threadId,
                    cause: authenticationCause(error, config.apiKey),
                  }),
              ),
            );
            yield* setSessionStatus("ready");
            boxes.delete(nativeId);
            const recreated = yield* saveThread(
              {
                ...previous,
                providerSessionId: input.providerSessionId,
                nativeThreadRef: { driver, nativeId: replacement.id, strength: "strong" },
                nativeConversationHeadRef: null,
                pendingBackgroundTasks: [],
                contextUsage: null,
                nativeMetadata: null,
                status: "idle",
                updatedAt: yield* DateTime.now,
              },
              replacement,
            );
            recreatedThreads.add(recreated.id);
            return recreated;
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
          const providerThread = request.providerThread;
          const box = boxes.get(providerThread.nativeThreadRef?.nativeId ?? "");
          if (!box) return yield* new Adapter.ProviderAdapterSessionStoppedError({ driver });
          const { apiKey } = yield* environment;
          // Managed agents start in the Box workspace, so they are told where the clone is.
          const prompt =
            harness !== "commandCode" && request.runtimePolicy.repositoryUrl
              ? `The repository is checked out at ${BOX_REPOSITORY_PATH}.\n\n${request.message.text}`
              : request.message.text;
          const runMarker = `t3stash-run:${Buffer.from(request.attemptId).toString("hex")}\n`;
          const streamPrompt = harness === "commandCode" ? runMarker + prompt : prompt;
          const translation = new BoxTurnTranslation(
            { ...request, providerThread },
            ids.derive,
            yield* DateTime.now,
          );
          let failureMessage: string | undefined;
          const streamError = (error: unknown, fromAgentStream = false) => {
            if (isMissingBox(error)) failureMessage = boxStoppedMessage;
            else if (
              fromAgentStream &&
              error instanceof BoxError &&
              error.statusCode === undefined &&
              error.cause === undefined &&
              Reflect.ownKeys(error).every(
                (key) =>
                  typeof key === "string" &&
                  ["message", "stack", "name", "statusCode", "cause"].includes(key),
              ) &&
              !/[{}]/u.test(error.message)
            ) {
              let raw = error.message;
              for (const key of [agent.agentApiKey, apiKey]) {
                if (key) raw = raw.replaceAll(key, "[REDACTED]");
              }
              const detail = raw.trim()
                ? makeProviderFailure({ message: raw })
                    .message.replace(
                      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
                      "[REDACTED]",
                    )
                    .replace(
                      /\b(?:sk|ghp|gho|github_pat|upstash|qstash)[_-][A-Za-z0-9_-]+\b/gu,
                      "[REDACTED]",
                    )
                    .replace(/\b[A-Za-z0-9_+/=-]{32,}\b/gu, "[REDACTED]")
                    .replace(/\s+/gu, " ")
                    .trim()
                : "";
              const short =
                detail.length > 200 ? `${Array.from(detail).slice(0, 199).join("")}…` : detail;
              failureMessage = short
                ? `The Box agent reported an error: ${short}. Send a message to retry.`
                : "The Box agent reported an error. Send a message to retry.";
            }
            return new BoxRuntimeError({ operation: "stream" });
          };
          const turn: ActiveTurn = { box, runMarker, translation, interrupted: false };
          active = turn;
          yield* publish(translation.start(yield* DateTime.now));
          if (recreatedThreads.has(providerThread.id)) {
            const at = yield* DateTime.now;
            yield* publish([
              {
                type: "turn_item.updated",
                driver,
                turnItem: {
                  id: ids.derive.turnItemFromProviderItem({
                    driver,
                    nativeItemId: `${request.attemptId}:box-recreated`,
                  }),
                  threadId: request.threadId,
                  runId: request.runId,
                  nodeId: request.rootNodeId,
                  providerThreadId: providerThread.id,
                  providerTurnId: translation.providerTurnId,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 0,
                  status: "completed",
                  title: "A new Box was started",
                  type: "system_notice",
                  level: "warning",
                  message:
                    "This thread's Box was gone, so a new one was started. The agent doesn't have the earlier conversation, and uncommitted changes from the old Box are lost.",
                  startedAt: at,
                  completedAt: at,
                  updatedAt: at,
                },
              },
            ]);
            recreatedThreads.delete(providerThread.id);
          }
          const process = Effect.gen(function* () {
            // Box resumes the agent from the prior finish.sessionId.
            const stream = yield* Effect.tryPromise({
              try: async () => {
                let stream: BoxStream;
                try {
                  stream = await box.agent.stream({ prompt: streamPrompt });
                } catch (error) {
                  if (!(error instanceof BoxError) || error.statusCode !== 409) throw error;
                  // A cancelled run can leave the Box rejecting work until explicitly resumed.
                  await box.resume();
                  stream = await box.agent.stream({ prompt: streamPrompt });
                }
                turn.stream = stream;
                return stream;
              },
              catch: (error) => streamError(error),
            }).pipe(Effect.uninterruptible);
            if (turn.interrupted) yield* cancelBoxRun(box, stream, runMarker);
            yield* Stream.fromAsyncIterable(stream, (error) => streamError(error, true)).pipe(
              Stream.runForEach((chunk) =>
                Effect.gen(function* () {
                  yield* publish(translation.accept(chunk, yield* DateTime.now));
                }),
              ),
            );
          });
          yield* process.pipe(
            Effect.onInterrupt(() =>
              turn.stream
                ? cancelBoxRun(box, turn.stream, runMarker).pipe(Effect.ignore)
                : Effect.void,
            ),
            Effect.isFailure,
            Effect.flatMap(
              Effect.fn("UpstashBox.finishTurn")(function* (failed) {
                if (
                  !turn.interrupted &&
                  (failed || !translation.hasFinished) &&
                  failureMessage !== boxStoppedMessage
                ) {
                  yield* Effect.promise(async () => {
                    try {
                      await box.getStatus();
                    } catch (error) {
                      if (isMissingBox(error)) failureMessage = boxStoppedMessage;
                    }
                  }).pipe(Effect.timeoutOption("3 seconds"));
                }
                if (translation.sessionId) {
                  const thread = providerThread;
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
                yield* publish(
                  translation.complete(
                    yield* DateTime.now,
                    turn.interrupted,
                    failed,
                    failureMessage,
                  ),
                );
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
          const { stream, box, runMarker } = active;
          if (stream)
            yield* cancelBoxRun(box, stream, runMarker).pipe(
              Effect.mapError(
                () =>
                  new Adapter.ProviderAdapterInterruptError({
                    driver,
                    providerThreadId: request.providerThread.id,
                    providerTurnId: request.providerTurnId,
                  }),
              ),
            );
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
          const turn = active;
          if (turn?.stream)
            yield* cancelBoxRun(turn.box, turn.stream, turn.runMarker).pipe(Effect.ignore);
          yield* Queue.shutdown(events);
        }),
      );
      return runtime;
    }),
  });
});
