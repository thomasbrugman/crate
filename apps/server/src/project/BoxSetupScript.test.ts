import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { BoxApi } from "@t3tools/provider-upstash-box/server";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import { BoxThreadResolver } from "../vcs/BoxThreadResolver.ts";
import * as BoxSetupScript from "./BoxSetupScript.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

const threadId = ThreadId.make("box-thread");
const projectId = ProjectId.make("project");

const unexpected = async (): Promise<never> => {
  throw new Error("Unexpected Box operation");
};

function makeHarness(options: {
  readonly worktree?: boolean;
  readonly result: ProjectSetupScriptRunner.ProjectSetupScriptRunnerResult;
}) {
  let marked = false;
  const commands: string[] = [];
  const command = vi.fn(async (line: string) => {
    commands.push(line);
    if (line.startsWith("rmdir")) marked = false;
    if (line.includes("mkdir --")) {
      if (marked) return { exitCode: 4, stdout: "" };
      marked = true;
    }
    return { exitCode: 0, stdout: "" };
  });
  const runForThread = vi.fn(() => Effect.succeed(options.result));
  const layer = BoxSetupScript.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(BoxThreadResolver)({
          resolveTerminal: () =>
            Effect.succeed({ nativeId: "box", apiKey: "key", worktree: options.worktree ?? false }),
        }),
        Layer.mock(BoxApi.BoxApi)({
          get: async () => ({ exec: { command } }) as never,
          create: unexpected,
          list: unexpected,
          checkModelKey: unexpected,
        }),
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({ runForThread }),
      ),
    ),
  );
  const runOnce = BoxSetupScript.BoxSetupScript.pipe(
    Effect.flatMap((service) => service.runOnce({ threadId, projectId, baseCommit: "abc123" })),
  );
  return { layer, runOnce, runForThread, commands, marked: () => marked };
}

const started = (async: boolean, exitCode: number) =>
  ({
    status: "started",
    scriptId: "setup",
    scriptName: "Setup",
    scriptCommand: "vp i",
    terminalId: "setup-setup",
    cwd: BoxApi.BOX_REPOSITORY_PATH,
    async,
    completion: Effect.succeed({ exitCode, durationMs: 1 }),
  }) as const;

describe("BoxSetupScript", () => {
  it.effect("runs the setup script once per Box checkout", () => {
    const harness = makeHarness({ result: started(true, 0) });
    return Effect.gen(function* () {
      yield* harness.runOnce;
      yield* harness.runOnce;
      expect(harness.runForThread).toHaveBeenCalledTimes(1);
      expect(harness.runForThread).toHaveBeenCalledWith(
        expect.objectContaining({ threadId, projectId, worktreePath: BoxApi.BOX_REPOSITORY_PATH }),
      );
      expect(harness.marked()).toBe(true);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("runs a subagent's setup in its own Box worktree", () => {
    const harness = makeHarness({ worktree: true, result: started(true, 0) });
    return Effect.gen(function* () {
      yield* harness.runOnce;
      expect(harness.commands[0]).toContain("worktree add --detach");
      expect(harness.commands[0]).toContain("'abc123'");
      expect(harness.runForThread).toHaveBeenCalledWith(
        expect.objectContaining({ worktreePath: BoxApi.boxWorktreePath(threadId) }),
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect.each([
    { name: "no script", result: { status: "no-script" } as const, fails: false },
    { name: "a blocking script that fails", result: started(false, 2), fails: true },
  ])("forgets the run after $name so the next turn checks again", ({ result, fails }) => {
    const harness = makeHarness({ result });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(harness.runOnce);
      expect(Exit.isFailure(exit)).toBe(fails);
      expect(harness.marked()).toBe(false);
    }).pipe(Effect.provide(harness.layer));
  });
});
