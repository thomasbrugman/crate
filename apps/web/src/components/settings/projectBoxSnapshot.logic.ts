import { msg } from "gt-react";

export function projectSnapshotErrorMessage(reason: unknown): string {
  switch (reason) {
    case "wrong-project":
      return msg("This thread does not belong to this project.");
    case "active-turn":
      return msg("Wait for the turn to finish before saving a snapshot.");
    case "not-box":
      return msg("This thread does not have an Upstash Box.");
    case "worktree":
      return msg("Save snapshots from the project's main setup thread, not a delegated worktree.");
    case "concurrent":
      return msg("A snapshot is already being saved for this project.");
    default:
      return msg("Could not save the snapshot. Check the Box connection and try again.");
  }
}
