import {
  SaveProjectBoxSnapshotError,
  type SaveProjectBoxSnapshotInput,
  type BoxSnapshot,
} from "@t3tools/contracts";
import { BoxApi } from "@t3tools/provider-upstash-box/server";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BoxThreadResolver from "../vcs/BoxThreadResolver.ts";

const isSaveProjectBoxSnapshotError = Schema.is(SaveProjectBoxSnapshotError);

export class ProjectBoxSnapshots extends Context.Service<
  ProjectBoxSnapshots,
  {
    readonly save: (
      input: typeof SaveProjectBoxSnapshotInput.Type,
    ) => Effect.Effect<BoxSnapshot, SaveProjectBoxSnapshotError>;
  }
>()("t3/project/ProjectBoxSnapshots") {}

const credentialPaths = [
  ".commandcode/auth.json",
  ".commandcode/config.json",
  ".codex/auth.json",
  ".claude/.credentials.json",
  ".claude.json",
  ".git-credentials",
  ".gitconfig",
].map((path) => `/home/boxuser/${path}`);

const make = Effect.gen(function* () {
  const projection = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const resolver = yield* BoxThreadResolver.BoxThreadResolver;
  const api = yield* BoxApi.BoxApi;
  const settings = yield* ServerSettings.ServerSettingsService;
  const saving = new Set<string>();
  const unavailable = () => new SaveProjectBoxSnapshotError({ reason: "unavailable" });
  const save = Effect.fn("ProjectBoxSnapshots.save")(function* (
    input: typeof SaveProjectBoxSnapshotInput.Type,
  ) {
    return yield* Effect.acquireUseRelease(
      Effect.suspend(() => {
        if (saving.has(input.projectId))
          return Effect.fail(new SaveProjectBoxSnapshotError({ reason: "concurrent" }));
        saving.add(input.projectId);
        return Effect.void;
      }),
      () =>
        Effect.gen(function* () {
          const records = yield* projection.getThreadRecords(input.threadId, [
            "runs",
            "providerTurns",
          ]);
          if (records.thread.projectId !== input.projectId || records.thread.deletedAt !== null)
            return yield* new SaveProjectBoxSnapshotError({ reason: "wrong-project" });
          if (
            records.runs.some((run) =>
              ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
            ) ||
            records.providerTurns.some(
              (turn) => turn.status === "pending" || turn.status === "running",
            )
          )
            return yield* new SaveProjectBoxSnapshotError({ reason: "active-turn" });
          const target = yield* resolver.resolveTerminal(input.threadId);
          if (!target) return yield* new SaveProjectBoxSnapshotError({ reason: "not-box" });
          const shell = yield* projection.getShellSnapshot();
          for (const thread of [...shell.threads, ...shell.archivedThreads]) {
            if (thread.id === input.threadId) continue;
            const other = yield* projection.getThreadRecords(thread.id, ["runs", "providerTurns"]);
            if (
              other.thread.deletedAt !== null ||
              (!other.runs.some((run) =>
                ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
              ) &&
                !other.providerTurns.some(
                  (turn) => turn.status === "pending" || turn.status === "running",
                ))
            )
              continue;
            const owner = yield* resolver.resolveTerminal(thread.id);
            if (owner?.nativeId === target.nativeId)
              return yield* new SaveProjectBoxSnapshotError({ reason: "active-turn" });
          }
          const project = yield* projects.get(input.projectId);
          if (Option.isNone(project) || project.value.deletedAt !== null)
            return yield* unavailable();
          const now = yield* DateTime.now;
          const timestamp = DateTime.formatIso(now)
            .replace(/[-:]/g, "")
            .replace("T", "-")
            .slice(0, 13);
          const slug =
            project.value.title
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "")
              .slice(0, 60) || "project";
          const name = `${slug}-setup-${timestamp}`;
          const box = yield* Effect.tryPromise({
            try: () => api.get(target.nativeId, target.apiKey),
            catch: unavailable,
          });
          const backup = `/dev/shm/t3stash-snapshot-${Buffer.from(input.projectId).toString("hex")}`;
          const command = (script: string) =>
            Effect.tryPromise({
              try: () => BoxApi.requireCommand(box, script),
              catch: unavailable,
            });
          let cleanupFailed = false;
          const snapshot = yield* Effect.acquireUseRelease(
            command(`test "$(stat -f -c %T /dev/shm)" = tmpfs && umask 077 && mkdir ${backup}`),
            () =>
              Effect.gen(function* () {
                yield* command(
                  credentialPaths
                    .map(
                      (path, index) =>
                        `if test -e ${path} || test -L ${path}; then mv -- ${path} ${backup}/${index}; fi`,
                    )
                    .join(" && "),
                );
                return yield* Effect.tryPromise({
                  try: async () => {
                    if (!box.snapshot) throw new Error("Snapshot unavailable.");
                    const result = await box.snapshot({ name });
                    if (result.status !== "ready") throw new Error("Snapshot unavailable.");
                    return result;
                  },
                  catch: unavailable,
                });
              }),
            () =>
              command(
                credentialPaths
                  .map(
                    (path, index) =>
                      `if test -e ${backup}/${index} || test -L ${backup}/${index}; then mv -- ${backup}/${index} ${path}; fi`,
                  )
                  .join(" && ") + ` && rmdir ${backup}`,
              ).pipe(
                Effect.catch(() =>
                  Effect.sync(() => {
                    cleanupFailed = true;
                  }),
                ),
              ),
          ).pipe(Effect.uninterruptible);
          if (cleanupFailed) return yield* unavailable();
          const current = yield* settings.getSettings;
          yield* settings.updateSettings({
            projectSettingsOverrides: {
              [input.projectId]: {
                ...current.projectSettingsOverrides[input.projectId],
                upstashBoxSnapshotId: snapshot.id,
                upstashBoxSetupThreadId: input.threadId,
              },
            },
            upstashBox: { snapshotNames: { [snapshot.id]: name } },
          });
          return snapshot;
        }).pipe(
          Effect.mapError((error) =>
            isSaveProjectBoxSnapshotError(error) ? error : unavailable(),
          ),
        ),
      () =>
        Effect.sync(() => {
          saving.delete(input.projectId);
        }),
    );
  });
  return ProjectBoxSnapshots.of({ save });
});

export const layer = Layer.effect(ProjectBoxSnapshots, make);
