import { describe, expect, it } from "vite-plus/test";
import { isCloudSurfaceUnavailable } from "./RightPanelSurfaceContent.logic";

describe("isCloudSurfaceUnavailable", () => {
  it.each(["terminal", "diff", "files", "file", "preview", "device"] as const)(
    "blocks %s only for cloud threads",
    (kind) => {
      expect(isCloudSurfaceUnavailable(true, kind)).toBe(true);
      expect(isCloudSurfaceUnavailable(false, kind)).toBe(false);
    },
  );

  it.each(["pull-request", "issue", "pull-requests", "side-chat"] as const)(
    "keeps %s available for cloud threads",
    (kind) => {
      expect(isCloudSurfaceUnavailable(true, kind)).toBe(false);
      expect(isCloudSurfaceUnavailable(false, kind)).toBe(false);
    },
  );
});
