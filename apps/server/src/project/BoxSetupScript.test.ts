// @effect-diagnostics nodeBuiltinImport:off - The marker commands run for real in bash against a local Git repository.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { BoxApi } from "@t3tools/provider-upstash-box/server";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
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

// The claim and marker commands run for real in bash, against a local stand-in for the Box workspace.
function makeWorkspace() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "box-setup-"));
  NodeChildProcess.execFileSync("git", ["init", "-q", NodePath.join(root, "repo")]);
  NodeChildProcess.execFileSync("git", [
    "-C",
    NodePath.join(root, "repo"),
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  ]);
  const run = async (command: string) => {
    const local = command.replaceAll(BoxApi.BOX_WORKSPACE_PATH, root);
    const result = NodeChildProcess.spawnSync("bash", ["-c", local], { encoding: "utf8" });
    return { exitCode: result.status ?? 1, stdout: result.stdout };
  };
  const markerDir = (checkout = BoxApi.BOX_REPOSITORY_PATH) => {
    const local = checkout.replaceAll(BoxApi.BOX_WORKSPACE_PATH, root);
    const gitDir = NodeChildProcess.execFileSync(
      "git",
      ["-C", local, "rev-parse", "--absolute-git-dir"],
      { encoding: "utf8" },
    ).trim();
    return NodePath.join(gitDir, "t3stash-setup-script");
  };
  return { run, markerDir, remove: () => NodeFS.rmSync(root, { recursive: true, force: true }) };
}

function makeHarness(options: {
  readonly worktree?: boolean;
  readonly result: () => ProjectSetupScriptRunner.ProjectSetupScriptRunnerResult;
}) {
  const workspace = makeWorkspace();
  let boxId = "box-1";
  const runForThread = vi.fn(() => Effect.sync(options.result));
  const layer = BoxSetupScript.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(BoxThreadResolver)({
          resolveTerminal: () =>
            Effect.sync(() => ({
              nativeId: boxId,
              apiKey: "key",
              worktree: options.worktree ?? false,
            })),
        }),
        Layer.mock(BoxApi.BoxApi)({
          get: async () => ({ exec: { command: workspace.run } }) as never,
          create: unexpected,
          list: unexpected,
          checkModelKey: unexpected,
        }),
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({ runForThread }),
      ),
    ),
  );
  const runOnce = BoxSetupScript.BoxSetupScript.pipe(
    Effect.flatMap((service) => service.runOnce({ threadId, projectId, baseCommit: "HEAD" })),
  );
  return {
    layer: Layer.merge(
      layer,
      Layer.effectDiscard(Effect.addFinalizer(() => Effect.sync(workspace.remove))),
    ),
    runOnce,
    runForThread,
    markerDir: workspace.markerDir,
    restoreInto: (id: string) => {
      boxId = id;
    },
  };
}

const started = (
  async: boolean,
  completion: Effect.Effect<ProjectSetupScriptRunner.ProjectSetupScriptCompletion>,
): ProjectSetupScriptRunner.ProjectSetupScriptRunnerResult => ({
  status: "started",
  scriptId: "setup",
  scriptName: "Setup",
  scriptCommand: "vp i",
  terminalId: "setup-setup",
  cwd: BoxApi.BOX_REPOSITORY_PATH,
  async,
  completion,
});
const exited = (exitCode: number) => Effect.succeed({ exitCode, durationMs: 1 });

describe("BoxSetupScript", () => {
  it.effect("runs the setup script once per Box checkout", () => {
    const harness = makeHarness({ result: () => started(true, exited(0)) });
    return Effect.gen(function* () {
      yield* harness.runOnce;
      yield* harness.runOnce;
      expect(harness.runForThread).toHaveBeenCalledTimes(1);
      expect(harness.runForThread).toHaveBeenCalledWith(
        expect.objectContaining({ threadId, projectId, worktreePath: BoxApi.BOX_REPOSITORY_PATH }),
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("runs a subagent's setup in its own Box worktree", () => {
    const harness = makeHarness({ worktree: true, result: () => started(true, exited(0)) });
    return Effect.gen(function* () {
      yield* harness.runOnce;
      const worktree = BoxApi.boxWorktreePath(threadId);
      expect(harness.runForThread).toHaveBeenCalledWith(
        expect.objectContaining({ worktreePath: worktree }),
      );
      expect(NodeFS.existsSync(harness.markerDir(worktree))).toBe(true);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("reruns in a Box restored from a snapshot taken before setup finished", () => {
    let completion =
      Effect.never as Effect.Effect<ProjectSetupScriptRunner.ProjectSetupScriptCompletion>;
    let async = true;
    const harness = makeHarness({ result: () => started(async, completion) });
    return Effect.gen(function* () {
      yield* harness.runOnce;
      harness.restoreInto("box-2");
      // Blocking, so the run is marked finished before the next restore.
      async = false;
      completion = exited(0);
      yield* harness.runOnce;
      // Finished in the restored Box, so a snapshot of it skips setup.
      harness.restoreInto("box-3");
      yield* harness.runOnce;
      expect(harness.runForThread).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect.each([
    { name: "no script", fails: false, result: () => ({ status: "no-script" }) as const },
    { name: "a blocking script that fails", fails: true, result: () => started(false, exited(2)) },
  ])("forgets the run after $name so the next turn checks again", ({ result, fails }) => {
    const harness = makeHarness({ result });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(harness.runOnce);
      expect(Exit.isFailure(exit)).toBe(fails);
      expect(NodeFS.existsSync(harness.markerDir())).toBe(false);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("forgets the run when the turn is stopped during blocking setup", () =>
    Effect.gen(function* () {
      const waiting = yield* Deferred.make<void>();
      const harness = makeHarness({
        result: () =>
          started(false, Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never))),
      });
      yield* Effect.gen(function* () {
        const fiber = yield* harness.runOnce.pipe(Effect.forkChild);
        yield* Deferred.await(waiting);
        yield* Fiber.interrupt(fiber);
        expect(NodeFS.existsSync(harness.markerDir())).toBe(false);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
