import { assert, it } from "@effect/vitest";
import { EventId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { BoxApi } from "@t3tools/provider-upstash-box/server";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BoxThreadResolver from "../vcs/BoxThreadResolver.ts";
import * as ProjectBoxSnapshots from "./ProjectBoxSnapshots.ts";

const projectId = ProjectId.make("project");
const threadId = ThreadId.make("setup");
const instanceId = ProviderInstanceId.make("box");
const stores = Layer.merge(ProjectionStore.layer, ProjectStore.layer).pipe(
  Layer.provide(SqlitePersistence.layerMemory),
);

it.effect.each([
  "success",
  "capture-failure",
  "cleanup-failure",
  "not-ready",
  "wrong-project",
  "active-turn",
  "shared-run",
  "shared-turn",
  "shared-archived",
  "other-box",
  "shared-idle",
  "shared-deleted",
  "not-box",
  "concurrent",
] as const)("saves project snapshots safely: %s", (scenario) =>
  Effect.gen(function* () {
    const projection = yield* ProjectionStore.ProjectionStoreV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const settings = yield* ServerSettings.ServerSettingsService;
    const now = yield* DateTime.now;
    const modelSelection = { instanceId, model: "test" };
    yield* projects.apply({
      sequence: 1,
      eventId: EventId.make("project"),
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
        title: "My Project!",
        workspaceRoot: "/workspace",
        defaultModelSelection: modelSelection,
        scripts: [],
        createdAt: DateTime.formatIso(now),
        updatedAt: DateTime.formatIso(now),
      },
    });
    yield* projection.apply({
      id: EventId.make("thread"),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        id: threadId,
        projectId,
        title: "Setup",
        providerInstanceId: instanceId,
        modelSelection,
        createdBy: "user",
        creationSource: "web",
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
    const before = yield* settings.getSettings;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const commands: string[] = [];
    const original = projection.getThreadRecords;
    const otherId = ThreadId.make("other-thread");
    const gated = {
      ...projection,
      getShellSnapshot: () =>
        projection.getShellSnapshot().pipe(
          Effect.map((snapshot) => ({
            ...snapshot,
            archivedThreads:
              scenario === "shared-archived"
                ? [{ ...snapshot.threads[0]!, id: otherId }]
                : snapshot.archivedThreads,
            threads:
              (scenario.startsWith("shared-") && scenario !== "shared-archived") ||
              scenario === "other-box"
                ? [...snapshot.threads, { ...snapshot.threads[0]!, id: otherId }]
                : snapshot.threads,
          })),
        ),
      getThreadRecords: (...args: Parameters<typeof original>) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          if (scenario === "concurrent") yield* Deferred.await(release);
          const records = yield* original(
            args[0] === otherId ? threadId : args[0],
            args[1],
            args[2],
          );
          if (args[0] === otherId)
            return {
              ...records,
              thread: {
                ...records.thread,
                id: otherId,
                archivedAt: scenario === "shared-archived" ? now : null,
                deletedAt: scenario === "shared-deleted" ? now : null,
              },
              runs:
                scenario === "shared-idle" || scenario === "shared-turn"
                  ? []
                  : [{ status: "running" }],
              providerTurns: scenario === "shared-turn" ? [{ status: "pending" }] : [],
            };
          return scenario === "active-turn"
            ? { ...records, runs: [{ status: "running" }] }
            : records;
        }),
    };
    const service = yield* ProjectBoxSnapshots.ProjectBoxSnapshots.pipe(
      Effect.provide(
        ProjectBoxSnapshots.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.mock(BoxThreadResolver.BoxThreadResolver)({
                resolveTerminal: (id) =>
                  Effect.succeed(
                    scenario === "not-box"
                      ? null
                      : {
                          nativeId:
                            scenario === "other-box" && id === otherId ? "other-box" : "actual-box",
                          apiKey: "private-key",
                          worktree: false,
                        },
                  ),
              }),
              Layer.mock(BoxApi.BoxApi)({
                create: async () => {
                  throw new Error("unexpected");
                },
                list: async () => {
                  throw new Error("unexpected");
                },
                checkModelKey: async () => {
                  throw new Error("unexpected");
                },
                get: async (id) => {
                  assert.equal(id, "actual-box");
                  return {
                    id,
                    agent: {
                      stream: async () => {
                        throw new Error("unexpected");
                      },
                    },
                    files: { write: async () => undefined },
                    delete: async () => undefined,
                    resume: async () => undefined,
                    getStatus: async () => ({ status: "running" }),
                    exec: {
                      command: async (command) => {
                        commands.push(command);
                        if (scenario === "cleanup-failure" && command.includes("rmdir"))
                          return { stdout: "", exitCode: 1 };
                        return { stdout: "", exitCode: 0 };
                      },
                    },
                    snapshot: async ({ name }) => {
                      assert.match(name, /^my-project-setup-\d{8}-\d{4}$/);
                      assert.include(commands.at(-1)!, "mv -- /home/boxuser/.git-credentials");
                      if (scenario === "capture-failure") throw new Error("private-key");
                      return {
                        id: "new-snapshot",
                        name,
                        status: scenario === "not-ready" ? "creating" : "ready",
                        createdAt: 1,
                      };
                    },
                  };
                },
              }),
            ),
          ),
        ),
      ),
      Effect.provideService(ProjectionStore.ProjectionStoreV2, gated as typeof projection),
    );
    const input = {
      projectId: scenario === "wrong-project" ? ProjectId.make("other") : projectId,
      threadId,
    };
    if (scenario === "active-turn" || scenario === "concurrent") {
      if (scenario === "concurrent") {
        const first = yield* service.save(input).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        assert.equal((yield* service.save(input).pipe(Effect.flip)).reason, "concurrent");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
      } else assert.equal((yield* service.save(input).pipe(Effect.flip)).reason, "active-turn");
    } else if (["success", "other-box", "shared-idle", "shared-deleted"].includes(scenario)) {
      assert.equal((yield* service.save(input)).id, "new-snapshot");
    } else {
      const error = yield* service.save(input).pipe(Effect.flip);
      assert.equal(
        error.reason,
        ["capture-failure", "cleanup-failure", "not-ready"].includes(scenario)
          ? "unavailable"
          : scenario.startsWith("shared-")
            ? "active-turn"
            : scenario,
      );
      assert.notInclude(JSON.stringify(error), "private-key");
    }
    const after = yield* settings.getSettings;
    if (
      ["success", "concurrent", "other-box", "shared-idle", "shared-deleted"].includes(scenario)
    ) {
      assert.equal(after.projectSettingsOverrides[projectId]?.upstashBoxSnapshotId, "new-snapshot");
      assert.equal(after.projectSettingsOverrides[projectId]?.upstashBoxSetupThreadId, threadId);
      assert.match(after.upstashBox.snapshotNames["new-snapshot"]!, /^my-project-setup-/);
      assert.equal(after.projectSettingsOverrides[projectId]?.defaultAutoPull, true);
      assert.equal(after.upstashBox.snapshotNames.old, "Old");
    } else assert.deepEqual(after, before);
    if (scenario === "success" || scenario === "capture-failure")
      assert.include(commands.at(-1)!, "rmdir /dev/shm/t3stash-snapshot-");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        stores,
        ServerSettings.ServerSettingsService.layerTest({
          projectSettingsOverrides: {
            [projectId]: { upstashBoxSnapshotId: "old", defaultAutoPull: true },
          },
          upstashBox: { snapshotNames: { old: "Old" } },
        }),
      ),
    ),
  ),
);
