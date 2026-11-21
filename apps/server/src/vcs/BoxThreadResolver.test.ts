import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import { BoxApi, BoxExec } from "@t3tools/provider-upstash-box/server";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BoxThreadResolver from "./BoxThreadResolver.ts";

const cases: ReadonlyArray<{
  readonly driver: string;
  readonly deleted?: boolean;
  readonly noNativeId?: boolean;
  readonly noRepository?: boolean;
  readonly unavailable?: boolean;
  readonly reason?: BoxExec.BoxExecError["reason"];
}> = [
  { driver: "boxCommandCode" },
  { driver: "boxClaudeCode" },
  { driver: "boxCodex" },
  { driver: "upstashBox" },
  { driver: "codex", reason: "thread_unavailable" },
  { driver: "boxCommandCode", deleted: true, reason: "thread_unavailable" },
  { driver: "boxCommandCode", noNativeId: true, reason: "thread_unavailable" },
  { driver: "boxCommandCode", noRepository: true },
  { driver: "boxCommandCode", unavailable: true, reason: "box_unavailable" },
];

const layerStores = Layer.merge(ProjectionStore.layer, ProjectStore.layer).pipe(
  Layer.provide(SqlitePersistence.layerMemory),
);

it.effect.each(cases)("resolves persisted Box identity and project context: %j", (scenario) => {
  const driver = ProviderDriverKind.make(scenario.driver);
  const instanceId = ProviderInstanceId.make("box-instance");
  const threadId = ThreadId.make("box-thread");
  const providerThreadId = ProviderThreadId.make("provider-thread");
  const projectId = ProjectId.make("project");
  return Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const now = yield* DateTime.now;
    const modelSelection = { instanceId, model: "test" };
    yield* projects.apply({
      sequence: 1,
      eventId: EventId.make("project-created"),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: DateTime.formatIso(now),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: "Box project",
        workspaceRoot: "/explicit/project",
        defaultModelSelection: modelSelection,
        scripts: [],
        createdAt: DateTime.formatIso(now),
        updatedAt: DateTime.formatIso(now),
      },
    });
    yield* store.apply({
      id: EventId.make("thread-created"),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        id: threadId,
        projectId,
        title: "Box thread",
        providerInstanceId: instanceId,
        modelSelection,
        createdBy: "user",
        creationSource: "web",
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThreadId,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: scenario.deleted ? now : null,
      },
    });
    yield* store.apply({
      id: EventId.make("provider-thread-updated"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: providerThreadId,
        driver,
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: scenario.noNativeId
          ? null
          : { driver, nativeId: "persisted-box", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    });
    const calls: string[] = [];
    const unexpected = async (): Promise<never> => {
      throw new Error("Unexpected Box operation");
    };
    const { target } = yield* BoxThreadResolver.make.pipe(
      Effect.provide(
        Layer.mock(BoxApi.BoxApi)({
          create: unexpected,
          list: unexpected,
          get: async (id, apiKey) => {
            calls.push(id);
            assert.equal(id, "persisted-box");
            assert.equal(apiKey, "box-api-key");
            if (scenario.unavailable) throw new Error("Box is unavailable");
            return {
              id,
              exec: {
                command: async () => ({
                  exitCode: 0,
                  stdout: scenario.noRepository ? "" : "https://github.com/team/repo.git\n",
                }),
              },
              agent: { stream: unexpected },
              files: { write: unexpected },
              delete: unexpected,
            };
          },
        }),
      ),
    );
    if (scenario.reason) {
      assert.equal((yield* target.resolve(threadId).pipe(Effect.flip)).reason, scenario.reason);
      assert.equal(calls.length, scenario.unavailable ? 1 : 0);
    } else {
      assert.deepEqual(yield* target.resolve(threadId), {
        threadId,
        projectRoot: "/explicit/project",
        checkoutRoot: scenario.noRepository ? "/workspace/home" : "/workspace/home/repo",
      });
      assert.deepEqual(calls, ["persisted-box"]);
    }
    const count = calls.length;
    assert.equal(
      (yield* target.resolve(ThreadId.make("missing")).pipe(Effect.flip)).reason,
      "resolve_failed",
    );
    assert.equal(calls.length, count);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        layerStores,
        ServerSettings.ServerSettingsService.layerTest({
          upstashBox: { apiKey: scenario.driver === "upstashBox" ? "" : "box-api-key" },
          providerInstances: { [instanceId]: { driver, config: { apiKey: "box-api-key" } } },
        }),
        Layer.mock(SecretResolver.SecretResolver)({}),
      ),
    ),
  );
});
