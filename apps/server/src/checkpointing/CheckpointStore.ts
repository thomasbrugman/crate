import { VcsRepositoryDetectionError, type CheckpointRef, type ThreadId } from "@t3tools/contracts";
import { BoxExec } from "@t3tools/provider-upstash-box/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { CheckpointStoreError } from "./Errors.ts";
import * as BoxThreadResolver from "../vcs/BoxThreadResolver.ts";
import type { VcsCheckpointOps, VcsCheckpointRange } from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsThreadTarget from "../vcs/VcsThreadTarget.ts";

interface CheckpointWorkspace {
  readonly cwd: string;
  readonly threadId?: ThreadId;
}

export interface CaptureCheckpointInput extends CheckpointWorkspace {
  readonly checkpointRef: CheckpointRef;
  /** The checkpoint this one follows, so a turn that switched branches starts where it landed. */
  readonly previousCheckpointRef?: CheckpointRef;
  /** Folders below `cwd` (relative, `/`-separated) that have their own checkpoints. */
  readonly excludePaths?: ReadonlyArray<string>;
}

export type CheckpointRange = VcsCheckpointRange;

export interface CaptureHeadCheckpointInput extends CheckpointWorkspace {
  readonly checkpointRef: CheckpointRef;
  /** A commit `resolveCleanHead` returned for this folder. */
  readonly head: string;
  /**
   * When the folder was seen clean, in epoch seconds, if that was earlier than now. Commits made
   * after a checkpoint count as the turn's own work, so a late snapshot must not postdate them.
   */
  readonly seenAt?: number;
}

export interface RestoreCheckpointInput extends CheckpointWorkspace {
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
  /** Folders below `cwd` the restore leaves as they are, as in a capture. */
  readonly excludePaths?: ReadonlyArray<string>;
}

export interface DiffCheckpointsInput extends CheckpointWorkspace {
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
  readonly format?: "patch" | "numstat";
  /** Maximum bytes collected from the diff command. */
  readonly maxOutputBytes?: number;
  /** Limits the diff to these exact paths. An empty list yields an empty diff. */
  readonly filePaths?: ReadonlyArray<string>;
  /** Folders below `cwd` left out of the diff, as in a capture. */
  readonly excludePaths?: ReadonlyArray<string>;
  /** The refs' range as their capture returned it; the refs are then not read. */
  readonly range?: VcsCheckpointRange;
}

export interface ListAuthoredPathsInput extends CheckpointWorkspace {
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  /** The refs' range as their capture returned it; the refs are then not read. */
  readonly range?: VcsCheckpointRange;
}

export interface DeleteCheckpointRefsInput extends CheckpointWorkspace {
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

export class CheckpointStore extends Context.Service<
  CheckpointStore,
  {
    readonly isGitRepository: (
      cwd: string,
      threadId?: ThreadId,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    /** The range from `previousCheckpointRef`, or null when there is none to compare with. */
    readonly captureCheckpoint: (
      input: CaptureCheckpointInput,
    ) => Effect.Effect<VcsCheckpointRange | null, CheckpointStoreError>;

    /**
     * HEAD's commit when the folder matches it exactly: nothing staged, modified or untracked.
     * Null otherwise. One status, where a capture stages the whole worktree.
     */
    readonly resolveCleanHead: (
      cwd: string,
      threadId?: ThreadId,
    ) => Effect.Effect<string | null, CheckpointStoreError>;

    /** Snapshots a folder that was clean at `head` from that commit, without reading its files. */
    readonly captureHeadCheckpoint: (
      input: CaptureHeadCheckpointInput,
    ) => Effect.Effect<void, CheckpointStoreError>;

    readonly hasCheckpointRef: (
      input: Omit<RestoreCheckpointInput, "fallbackToHead">,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    readonly restoreCheckpoint: (
      input: RestoreCheckpointInput,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    readonly diffCheckpoints: (
      input: DiffCheckpointsInput,
    ) => Effect.Effect<string, CheckpointStoreError>;

    /** Null means HEAD is unchanged or unrecorded; all changed paths then belong to the turn. */
    readonly listAuthoredPaths: (
      input: ListAuthoredPathsInput,
    ) => Effect.Effect<ReadonlySet<string> | null, CheckpointStoreError>;

    readonly deleteCheckpointRefs: (
      input: DeleteCheckpointRefsInput,
    ) => Effect.Effect<void, CheckpointStoreError>;
  }
>()("t3/checkpointing/CheckpointStore") {}

/** @public */
export const make = Effect.gen(function* () {
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const boxResolver = yield* Effect.serviceOption(BoxThreadResolver.BoxThreadResolver);
  const boxExec = yield* Effect.serviceOption(BoxExec.BoxExec);

  const withWorkspace = Effect.fn("CheckpointStore.withWorkspace")(function* <A, E, R>(
    workspace: CheckpointWorkspace,
    effect: (cwd: string) => Effect.Effect<A, E, R>,
  ) {
    if (workspace.threadId === undefined || Option.isNone(boxResolver))
      return yield* effect(workspace.cwd);
    const target = yield* boxResolver.value.resolveCheckpointTarget(workspace.threadId).pipe(
      Effect.mapError(
        (cause) =>
          new VcsRepositoryDetectionError({
            operation: "CheckpointStore.Box",
            cwd: workspace.cwd,
            detail: "Box unavailable for this thread.",
            cause,
          }),
      ),
    );
    if (target === undefined) return yield* effect(workspace.cwd);
    const operation = effect(target.checkoutRoot).pipe(
      Effect.provideService(VcsThreadTarget.VcsThreadTarget, target),
    );
    return yield* Option.isSome(boxExec)
      ? operation.pipe(Effect.provideService(BoxExec.BoxExec, boxExec.value))
      : operation;
  });

  const resolveCheckpoints = Effect.fn("CheckpointStore.resolveCheckpoints")(function* (
    cwd: string,
  ) {
    const handle = yield* vcsRegistry.resolve({ cwd });
    return handle.driver.checkpoints satisfies VcsCheckpointOps;
  });

  // The registry reads an unreadable repository as none; ask Git again so that fails here.
  const isGitRepository: CheckpointStore["Service"]["isGitRepository"] = Effect.fn(
    "CheckpointStore.isGitRepository",
  )((cwd, threadId) =>
    withWorkspace({ cwd, ...(threadId === undefined ? {} : { threadId }) }, (cwd) =>
      Effect.gen(function* () {
        if ((yield* vcsRegistry.detect({ cwd, requestedKind: "git" })) !== null) return true;
        const git = yield* vcsRegistry.get("git");
        return (yield* git.detectRepository(cwd)) !== null;
      }),
    ),
  );

  const withCheckpoints = <A>(
    input: CheckpointWorkspace,
    operation: (
      checkpoints: VcsCheckpointOps,
      cwd: string,
    ) => Effect.Effect<A, CheckpointStoreError>,
  ) =>
    withWorkspace(input, (cwd) =>
      resolveCheckpoints(cwd).pipe(Effect.flatMap((checkpoints) => operation(checkpoints, cwd))),
    );

  const captureCheckpoint: CheckpointStore["Service"]["captureCheckpoint"] = Effect.fn(
    "captureCheckpoint",
  )((input) =>
    withCheckpoints(input, (checkpoints, cwd) => checkpoints.captureCheckpoint({ ...input, cwd })),
  );

  const resolveCleanHead: CheckpointStore["Service"]["resolveCleanHead"] = Effect.fn(
    "CheckpointStore.resolveCleanHead",
  )((cwd, threadId) =>
    withWorkspace({ cwd, ...(threadId === undefined ? {} : { threadId }) }, (cwd) =>
      resolveCheckpoints(cwd).pipe(
        Effect.flatMap((checkpoints) => checkpoints.resolveCleanHead(cwd)),
      ),
    ),
  );

  const captureHeadCheckpoint: CheckpointStore["Service"]["captureHeadCheckpoint"] = Effect.fn(
    "CheckpointStore.captureHeadCheckpoint",
  )((input) =>
    withCheckpoints(input, (checkpoints, cwd) =>
      checkpoints.captureHeadCheckpoint({ ...input, cwd }),
    ),
  );

  const hasCheckpointRef: CheckpointStore["Service"]["hasCheckpointRef"] = Effect.fn(
    "hasCheckpointRef",
  )((input) =>
    withCheckpoints(input, (checkpoints, cwd) => checkpoints.hasCheckpointRef({ ...input, cwd })),
  );

  const restoreCheckpoint: CheckpointStore["Service"]["restoreCheckpoint"] = Effect.fn(
    "restoreCheckpoint",
  )((input) =>
    withCheckpoints(input, (checkpoints, cwd) => checkpoints.restoreCheckpoint({ ...input, cwd })),
  );

  const diffCheckpoints: CheckpointStore["Service"]["diffCheckpoints"] = Effect.fn(
    "diffCheckpoints",
  )((input) =>
    withCheckpoints(input, (checkpoints, cwd) => checkpoints.diffCheckpoints({ ...input, cwd })),
  );

  const listAuthoredPaths: CheckpointStore["Service"]["listAuthoredPaths"] = Effect.fn(
    "listAuthoredPaths",
  )((input) =>
    withCheckpoints(input, (checkpoints, cwd) => checkpoints.listAuthoredPaths({ ...input, cwd })),
  );

  const deleteCheckpointRefs: CheckpointStore["Service"]["deleteCheckpointRefs"] = Effect.fn(
    "deleteCheckpointRefs",
  )((input) =>
    withCheckpoints(input, (checkpoints, cwd) =>
      checkpoints.deleteCheckpointRefs({ ...input, cwd }),
    ),
  );

  return CheckpointStore.of({
    isGitRepository,
    captureCheckpoint,
    resolveCleanHead,
    captureHeadCheckpoint,
    hasCheckpointRef,
    restoreCheckpoint,
    diffCheckpoints,
    listAuthoredPaths,
    deleteCheckpointRefs,
  });
});

export const layer = Layer.effect(CheckpointStore, make);
