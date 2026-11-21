import type { RightPanelSurface } from "../../rightPanelStore";

export function isCloudSurfaceUnavailable(
  cloudThread: boolean,
  kind: RightPanelSurface["kind"],
): boolean {
  return (
    cloudThread &&
    ["terminal", "diff", "files", "file", "file-preview", "preview", "device"].includes(kind)
  );
}
