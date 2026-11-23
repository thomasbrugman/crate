import { describe, expect, it } from "vite-plus/test";
import { projectSnapshotErrorMessage } from "./projectBoxSnapshot.logic";
import { m } from "../../i18n/messages";

describe("project snapshot errors", () => {
  it.each([
    ["wrong-project", "This thread does not belong to this project."],
    ["active-turn", "Wait for the turn to finish before saving a snapshot."],
    ["not-box", "This thread does not have an Upstash Box."],
    ["worktree", "Save snapshots from the project's main setup thread, not a delegated worktree."],
    ["concurrent", "A snapshot is already being saved for this project."],
    ["unavailable", "Could not save the snapshot. Check the Box connection and try again."],
    [undefined, "Could not save the snapshot. Check the Box connection and try again."],
  ])("explains %s without exposing error details", (reason, expected) => {
    expect(m(projectSnapshotErrorMessage(reason))).toBe(expected);
  });
});
