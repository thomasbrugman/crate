import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

vi.mock("../state/environments", () => ({
  readEnvironmentProviders: (environmentId: string) =>
    environmentId === "missing"
      ? undefined
      : [
          { instanceId: "box", driver: "upstashBox" },
          { instanceId: "local", driver: "codex" },
        ],
}));

import { boxThreadDeletionWarning } from "./boxThreadDeletionWarning";

const thread = (instanceId: string, environmentId = "environment") => ({
  environmentId: EnvironmentId.make(environmentId),
  runtime: null,
  modelSelection: { instanceId: ProviderInstanceId.make(instanceId), model: "default" },
});

it("warns for Box threads in single and mixed deletions", () => {
  const warning = boxThreadDeletionWarning([thread("box")]);
  expect(warning).toContain("permanently deletes its Box and any unpushed changes");
  expect(boxThreadDeletionWarning([thread("local"), thread("box")])).toBe(warning);
  const activeBoxThread = {
    ...thread("local"),
    runtime: {
      status: "idle" as const,
      activeRunId: null,
      providerInstanceId: ProviderInstanceId.make("box"),
      providerName: null,
      lastError: null,
      updatedAt: "2026-01-01T00:00:00Z",
    },
  };
  expect(boxThreadDeletionWarning([activeBoxThread])).toBe(warning);
});

it("does not add a warning for empty, local or unknown-provider selections", () => {
  for (const threads of [[], [thread("local")], [thread("unknown")], [thread("box", "missing")]]) {
    expect(boxThreadDeletionWarning(threads)).toBeNull();
  }
});
