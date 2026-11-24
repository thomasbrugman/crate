import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { BoxApi } from "@t3tools/provider-upstash-box/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { BoxThreadResolver } from "../vcs/BoxThreadResolver.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

export class BoxSetupScriptError extends Schema.TaggedError<BoxSetupScriptError>()(
  "BoxSetupScriptError",
  { message: Schema.String },
) {}

/**
 * A Box checkout is the thread's worktree, so the project's setup script runs once per
 * checkout, in the thread's Box terminal, before its first turn.
 */
export class BoxSetupScript extends Context.Service<
  BoxSetupScript,
  {
    readonly runOnce: (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly baseCommit?: string | undefined;
    }) => Effect.Effect<void, BoxSetupScriptError>;
  }
>()("t3/project/BoxSetupScript") {}

// Inside the checkout's own git dir, so snapshots keep it and `git status` never shows it.
const MARKER = "t3stash-setup-script";
const NO_CHECKOUT = 3;
const ALREADY_RAN = 4;

const gitDir = (checkout: string) =>
  `"$(git -C ${BoxApi.quoteShell(checkout)} rev-parse --absolute-git-dir 2>/dev/null)"`;

const make = Effect.gen(function* () {
  const resolver = yield* BoxThreadResolver;
  const api = yield* BoxApi.BoxApi;
  const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const scope = yield* Effect.scope;

  const runOnce: BoxSetupScript["Service"]["runOnce"] = Effect.fn("BoxSetupScript.runOnce")(
    function* (input) {
      const target = yield* resolver
        .resolveTerminal(input.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (!target) return;
      const claim = yield* Effect.tryPromise({
        try: async () => {
          const box = await api.get(target.nativeId, target.apiKey);
          const checkout = target.worktree
            ? await BoxApi.ensureBoxWorktree(box, input.threadId, input.baseCommit)
            : BoxApi.BOX_REPOSITORY_PATH;
          const dir = gitDir(checkout);
          const claimed = await box.exec.command(
            `test -n ${dir} || exit ${NO_CHECKOUT}; mkdir -- ${dir}/${MARKER} 2>/dev/null || exit ${ALREADY_RAN}`,
          );
          const release = () =>
            Effect.promise(() =>
              box.exec.command(`rmdir -- ${dir}/${MARKER}`).then(
                () => undefined,
                () => undefined,
              ),
            );
          return claimed.exitCode === 0 ? { checkout, release } : null;
        },
        catch: () => new BoxSetupScriptError({ message: "The Box checkout could not be read." }),
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Box setup script check failed", {
            threadId: input.threadId,
            cause,
          }).pipe(Effect.as(null)),
        ),
      );
      if (claim === null) return;

      const started = yield* runner
        .runForThread({
          threadId: input.threadId,
          projectId: input.projectId,
          worktreePath: claim.checkout,
          observeCompletion: {},
        })
        .pipe(
          Effect.catchCause((cause) =>
            // Retry on the next turn rather than failing the agent on a terminal hiccup.
            Effect.logWarning("Box setup script did not start", {
              threadId: input.threadId,
              cause,
            }).pipe(Effect.andThen(claim.release()), Effect.as(null)),
          ),
        );
      if (started === null) return;
      if (started.status === "no-script") return yield* claim.release();
      if (started.status !== "started" || started.completion === undefined) return;
      if (started.async) {
        yield* started.completion.pipe(
          Effect.tap(({ exitCode }) =>
            exitCode === 0
              ? Effect.void
              : Effect.logWarning("Box setup script failed", {
                  threadId: input.threadId,
                  script: started.scriptName,
                  exitCode,
                }),
          ),
          Effect.forkIn(scope),
        );
        return;
      }
      const { exitCode } = yield* started.completion;
      if (exitCode === 0) return;
      yield* claim.release();
      return yield* new BoxSetupScriptError({
        message: `Setup script "${started.scriptName}" exited with ${exitCode ?? "no exit code"}. Its output is in the ${started.terminalId} terminal; send a message to run it again.`,
      });
    },
  );

  return BoxSetupScript.of({ runOnce });
});

export const layer = Layer.effect(BoxSetupScript, make);
