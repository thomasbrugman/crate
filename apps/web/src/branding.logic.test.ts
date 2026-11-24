import { expect, it } from "vite-plus/test";

import { resolveDesktopAppHandoff } from "./branding.logic";

it("matches the macOS handoff scheme to the Crate install guide", () => {
  expect(resolveDesktopAppHandoff("macOS")).toEqual({
    scheme: "crate",
    macInstallUrl: "https://github.com/thomasbrugman/t3stash#mac",
  });
  expect(resolveDesktopAppHandoff("macOS", true)).toEqual({
    scheme: "t3code-dev",
    macInstallUrl: null,
  });
  expect(resolveDesktopAppHandoff("iOS")).toEqual({
    scheme: "t3code",
    macInstallUrl: null,
  });
});
