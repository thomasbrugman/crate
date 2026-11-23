import * as Schema from "effect/Schema";
import { ProjectId, ThreadId } from "./baseSchemas.ts";

export const SaveProjectBoxSnapshotInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
});

export class SaveProjectBoxSnapshotError extends Schema.TaggedError<SaveProjectBoxSnapshotError>()(
  "SaveProjectBoxSnapshotError",
  {
    reason: Schema.Literals([
      "wrong-project",
      "active-turn",
      "not-box",
      "worktree",
      "unavailable",
      "concurrent",
    ]),
  },
) {
  override get message(): string {
    return `Could not save project Box snapshot (${this.reason}).`;
  }
}

export const BoxSnapshot = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["creating", "ready", "error"]),
  createdAt: Schema.Number,
});
export type BoxSnapshot = typeof BoxSnapshot.Type;

export const BoxSnapshotList = Schema.Struct({ snapshots: Schema.Array(BoxSnapshot) });

export class BoxSnapshotsError extends Schema.TaggedError<BoxSnapshotsError>()(
  "BoxSnapshotsError",
  { reason: Schema.Literals(["not-configured", "unavailable"]) },
) {
  override get message(): string {
    return this.reason === "not-configured"
      ? "Connect Upstash Box in Connections to load snapshots."
      : "Could not load Box snapshots. Check your Box connection and try again.";
  }
}
