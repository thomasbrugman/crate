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
import * as Effect from "effect/Effect";

import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { cleanupBoxThreads, cleanupSettledBoxes } from "./ResourceCleanupService.ts";

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
          const adapter = Adapter.ProviderAdapterV2.of({
            instanceId,
            driver,
            getCapabilities: () => Effect.die("unused"),
            planSelectionTransition: () => Effect.die("unused"),
            openSession: () => Effect.die("unused"),
            deleteThread: Effect.fn("test.deleteBox")(function* (thread) {
              removed.push(thread.id);
              if (fails && removed.length === 1) {
                return yield* new Adapter.ProviderAdapterProtocolError({
                  driver,
                  detail: "Delete failed.",
                });
              }
            }),
          });
          const cleanup = (providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>) =>
            cleanupBoxThreads({ threadId, deleted, providerThreads }).pipe(
              Effect.provide(ProviderAdapterRegistry.layerFromAdapters([adapter])),
            );
          yield* cleanup([]);
          yield* cleanup([{ ...providerThread, driver: ProviderDriverKind.make("codex") }]);
          assert.isEmpty(removed);
          yield* cleanup([
            { ...providerThread, providerInstanceId: ProviderInstanceId.make("missing") },
            providerThread,
            { ...providerThread, id: ProviderThreadId.make("second-box") },
          ]);
          assert.deepEqual(removed, deleted ? [providerThread.id, "second-box"] : []);
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
      shell("settled-two-days", { settledAt: at(-2) }),
      shell("recent-message", { latestUserMessageAt: at(-1) }),
      shell("unsettled", { settledAt: null }),
      shell("running", { activeRunId: "run-1" as OrchestrationV2ThreadShell["activeRunId"] }),
      shell("codex", {}),
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
  }),
);
