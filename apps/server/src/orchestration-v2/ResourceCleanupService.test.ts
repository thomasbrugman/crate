import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { cleanupBoxThreads } from "./ResourceCleanupService.ts";

it.effect(
  "retains archived Boxes and cleans deleted Boxes independently of individual failures",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const instanceId = ProviderInstanceId.make("box-cleanup");
      const driver = ProviderDriverKind.make("upstashBox");
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
