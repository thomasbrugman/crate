import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as ProjectionStore from "./ProjectionStore.ts";
import * as BoxThreadCleanup from "./BoxThreadCleanup.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { cleanupBoxThreads, cleanupSettledBoxes } from "./ResourceCleanupService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

it.effect(
  "retains archived Boxes and cleans deleted Boxes independently of individual failures",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const instanceId = ProviderInstanceId.make("box-cleanup");
      const driver = ProviderDriverKind.make("boxCommandCode");
      const threadId = ThreadId.make("box-cleanup-thread");
      const providerThread: OrchestrationV2ProviderThread = {
        id: ProviderThreadId.make("box-cleanup-provider-thread"),
        driver,
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "closed",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        contextUsage: null,
        nativeMetadata: null,
        goal: null,
        createdAt: now,
        updatedAt: now,
      };
      for (const deleted of [false, true]) {
        for (const fails of [false, true]) {
          const removed: ProviderThreadId[] = [];
          const boxes = BoxThreadCleanup.BoxThreadCleanup.of({
            remove: Effect.fn("test.deleteBox")(function* ({ providerThread: thread }) {
              removed.push(thread.id);
              if (fails && removed.length === 1) {
                return yield* new BoxThreadCleanup.BoxThreadCleanupError({
                  threadId,
                  reason: "delete_failed",
                });
              }
            }),
          });
          const cleanup = (providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>) =>
            cleanupBoxThreads({ threadId, deleted, providerThreads }).pipe(
              Effect.provideService(BoxThreadCleanup.BoxThreadCleanup, boxes),
              Effect.result,
            );
          yield* cleanup([]);
          yield* cleanup([{ ...providerThread, driver: ProviderDriverKind.make("codex") }]);
          assert.isEmpty(removed);
          const result = yield* cleanup([
            {
              ...providerThread,
              id: ProviderThreadId.make("missing-instance-box"),
              providerInstanceId: ProviderInstanceId.make("missing"),
            },
            providerThread,
            { ...providerThread, id: ProviderThreadId.make("second-box") },
            {
              ...providerThread,
              id: ProviderThreadId.make("legacy-box"),
              driver: ProviderDriverKind.make("upstashBox"),
            },
          ]);
          assert.deepEqual(
            removed,
            deleted ? ["missing-instance-box", providerThread.id, "second-box", "legacy-box"] : [],
          );
          assert.equal(result._tag, deleted && fails ? "Failure" : "Success");
        }
      }
    }),
);

it.effect("deletes Boxes of threads settled and quiet for three days unless they hold work", () =>
  Effect.gen(function* () {
    const DAY_MS = 86_400_000;
    const at = (days: number) => DateTime.makeUnsafe(days * DAY_MS);
    const instanceId = ProviderInstanceId.make("box-cleanup");
    const driver = ProviderDriverKind.make("boxCommandCode");
    const shell = (id: string, overrides: Partial<OrchestrationV2ThreadShell>) =>
      ({
        id: ThreadId.make(id),
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: ThreadId.make(id),
        },
        status: "idle",
        activeRunId: null,
        pendingRuntimeRequest: null,
        pendingBackgroundTasks: [],
        latestRunId: null,
        latestRunRequestedAt: null,
        latestRunStartedAt: null,
        latestRunCompletedAt: null,
        latestUserMessageAt: null,
        createdAt: at(-30),
        settledAt: at(-4),
        ...overrides,
      }) as OrchestrationV2ThreadShell;
    const threads = [
      shell("due", {}),
      shell("holds-work", {}),
      shell("has-running-child", {}),
      shell("settled-two-days", { settledAt: at(-2) }),
      shell("recent-message", { latestUserMessageAt: at(-1) }),
      shell("unsettled", { settledAt: null }),
      shell("running", { activeRunId: "run-1" as OrchestrationV2ThreadShell["activeRunId"] }),
      shell("codex", {}),
      shell("child", {
        lineage: {
          parentThreadId: ThreadId.make("due"),
          relationshipToParent: "subagent",
          rootThreadId: ThreadId.make("due"),
        },
      }),
      shell("running-child", {
        activeRunId: "run-2" as OrchestrationV2ThreadShell["activeRunId"],
        lineage: {
          parentThreadId: ThreadId.make("has-running-child"),
          relationshipToParent: "subagent",
          rootThreadId: ThreadId.make("has-running-child"),
        },
      }),
      shell("followed-up", {}),
    ];
    const current = (threadId: ThreadId) =>
      threadId === "followed-up"
        ? { ...threads.at(-1)!, latestUserMessageAt: at(0) }
        : threads.find((thread) => thread.id === threadId)!;
    const providerThread = (threadId: ThreadId) =>
      ({
        id: ProviderThreadId.make(`${threadId}-box`),
        driver: threadId === "codex" ? ProviderDriverKind.make("codex") : driver,
        providerInstanceId: instanceId,
        appThreadId: threadId,
      }) as OrchestrationV2ProviderThread;
    const checked: string[] = [];
    const adapter = Adapter.ProviderAdapterV2.of({
      instanceId,
      driver,
      getCapabilities: () => Effect.die("unused"),
      planSelectionTransition: () => Effect.die("unused"),
      openSession: () => Effect.die("unused"),
      deleteIdleThread: (thread) =>
        Effect.sync(() => {
          checked.push(thread.appThreadId!);
          return thread.appThreadId !== "holds-work";
        }),
    });
    const sweep = (released: Set<string>) =>
      cleanupSettledBoxes(released).pipe(
        Effect.provide(ProviderAdapterRegistry.layerFromAdapters([adapter])),
        Effect.provideService(ProjectionStore.ProjectionStoreV2, {
          getShellSnapshot: () => Effect.succeed({ threads }),
          getThreadShell: (threadId: ThreadId) => Effect.succeed(current(threadId)),
          getThreadRecords: (threadId: ThreadId) =>
            Effect.succeed({ providerThreads: [providerThread(threadId)] }),
        } as unknown as ProjectionStore.ProjectionStoreV2Shape),
      );
    const released = new Set<string>();
    yield* sweep(released);
    assert.deepEqual(checked, ["due", "holds-work"]);
    yield* sweep(released);
    assert.deepEqual(checked, ["due", "holds-work", "holds-work"]);
  }).pipe(Effect.provide(ThreadCommandExecutor.layer)),
);

it.effect("serializes settled Box deletion with follow-up intake in either order", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const order of ["cleanup-first", "turn-first", "cleanup-error"] as const) {
        const cleanupFirst = order !== "turn-first";
        const dispatch = yield* ThreadCommandExecutor.make;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("concurrent-follow-up");
        const instanceId = ProviderInstanceId.make("box-cleanup");
        const driver = ProviderDriverKind.make("boxCommandCode");
        let shell = {
          id: threadId,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          activeRunId: null,
          pendingRuntimeRequest: null,
          pendingBackgroundTasks: [],
          settledAt: DateTime.makeUnsafe(DateTime.toEpochMillis(now) - 4 * 86_400_000),
        } as unknown as OrchestrationV2ThreadShell;
        const thread = {
          id: ProviderThreadId.make("concurrent-box"),
          appThreadId: threadId,
          providerInstanceId: instanceId,
          driver,
        } as OrchestrationV2ProviderThread;
        let started = false;
        let deleted = false;
        const adapter = Adapter.ProviderAdapterV2.of({
          instanceId,
          driver,
          getCapabilities: () => Effect.die("unused"),
          planSelectionTransition: () => Effect.die("unused"),
          openSession: () => Effect.die("unused"),
          deleteIdleThread: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              assert.isFalse(started);
              if (order === "cleanup-error")
                return yield* new Adapter.ProviderAdapterProtocolError({
                  driver,
                  detail: "Delete failed.",
                });
              deleted = true;
              return true;
            }),
        });
        const sweep = cleanupSettledBoxes(new Set()).pipe(
          Effect.provideService(ThreadCommandExecutor.ThreadCommandExecutor, dispatch),
          Effect.provide(ProviderAdapterRegistry.layerFromAdapters([adapter])),
          Effect.provideService(ProjectionStore.ProjectionStoreV2, {
            getShellSnapshot: () => Effect.succeed({ threads: [shell] }),
            getThreadShell: () => Effect.sync(() => shell),
            getThreadRecords: () => Effect.succeed({ providerThreads: [thread] }),
          } as unknown as ProjectionStore.ProjectionStoreV2Shape),
        );
        const followUp = dispatch.withLock(
          threadId,
          Effect.gen(function* () {
            if (!cleanupFirst) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
            started = true;
            shell = { ...shell, latestUserMessageAt: now };
          }),
        );
        const first = yield* (cleanupFirst ? sweep : followUp).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(entered);
        const second = yield* (cleanupFirst ? followUp : sweep).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        assert.isFalse(started);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        assert.isTrue(started);
        assert.equal(deleted, order === "cleanup-first");
      }
    }),
  ),
);
