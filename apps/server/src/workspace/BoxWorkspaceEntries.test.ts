// @effect-diagnostics nodeBuiltinImport:off - executes the Box-side program against a disposable checkout.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { BoxExec } from "@t3tools/provider-upstash-box/server";
import * as Effect from "effect/Effect";
import { discover, search } from "./BoxWorkspaceEntries.ts";

const threadId = ThreadId.make("box-thread");

function withCheckout<A, E>(use: (cwd: string) => Effect.Effect<A, E, BoxExec.BoxExec>) {
  return Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "box-composer-"))),
        (folder) => Effect.sync(() => NodeFS.rmSync(folder, { recursive: true, force: true })),
      );
      return yield* use(cwd).pipe(
        Effect.provideService(BoxExec.BoxExec, {
          run: (input) =>
            Effect.sync(() => {
              assert.equal(input.threadId, threadId);
              assert.isUndefined(input.cwd);
              return {
                exitCode: 0,
                stdout: NodeChildProcess.execFileSync(
                  process.execPath,
                  ["-e", ...(input.args ?? [])],
                  {
                    cwd,
                    encoding: "utf8",
                  },
                ),
                stderr: "",
              };
            }),
        }),
      );
    }),
  );
}

function write(cwd: string, path: string, text: string) {
  const target = NodePath.join(cwd, path);
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
  NodeFS.writeFileSync(target, text);
}

it.live(
  "searches the resolved Box checkout for tracked and untracked paths, not ignored files",
  () =>
    withCheckout((cwd) =>
      Effect.gen(function* () {
        NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd });
        write(cwd, ".gitignore", "ignore/\n");
        write(cwd, "src/box-file.ts", "tracked");
        NodeChildProcess.execFileSync("git", ["add", "src/box-file.ts"], { cwd });
        write(cwd, "src/box-file-new.ts", "untracked");
        write(cwd, "ignore/box-file.ts", "ignored");
        const input = { cwd: "/host/checkout", boxThreadId: threadId, query: "bxf", limit: 1 };
        assert.deepEqual(yield* search(input), {
          entries: [{ path: "src/box-file.ts", kind: "file" }],
          truncated: true,
        });
        assert.deepEqual(yield* search({ ...input, query: "ignore/box", limit: 10 }), {
          entries: [],
          truncated: false,
        });
      }),
    ),
);

it.live("discovers native commands and skills with workspace precedence and invocation flags", () =>
  withCheckout((cwd) =>
    Effect.gen(function* () {
      write(cwd, ".commandcode/commands/review/check.md", "# Check the changes\nReview the diff");
      write(
        cwd,
        ".commandcode/skills/guide/SKILL.md",
        "---\nname: guide\ndescription: Command Code guide\nuser-invocable: false\n---\nBody",
      );
      write(
        cwd,
        ".agents/skills/guide/SKILL.md",
        "---\nname: guide\ndescription: Shared guide\n---\nBody",
      );
      const commandCode = yield* discover({ threadId, harness: "commandCode" });
      assert.deepEqual(commandCode.slashCommands, [
        { name: "check", description: "Check the changes" },
      ]);
      assert.deepEqual(commandCode.skills, [
        {
          name: "guide",
          description: "Command Code guide",
          path: NodePath.join(cwd, ".commandcode/skills/guide/SKILL.md"),
          scope: "project",
          enabled: true,
          userInvocable: false,
        },
      ]);
      const codex = yield* discover({ threadId, harness: "codex" });
      assert.deepEqual(codex.slashCommands, []);
      assert.equal(codex.skills[0]?.description, "Shared guide");
    }),
  ),
);
