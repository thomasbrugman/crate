import { ThreadId } from "@t3tools/contracts";
import { BoxApi } from "@t3tools/provider-upstash-box/server";
import type * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { BoxThreadResolver } from "../vcs/BoxThreadResolver.ts";

class BoxPtyError extends Schema.TaggedError<BoxPtyError>()("BoxPtyError", {
  message: Schema.String,
}) {}

export class BoxPty extends Context.Service<
  BoxPty,
  {
    readonly spawn: (input: {
      readonly threadId: string;
      readonly cols: number;
      readonly rows: number;
    }) => Effect.Effect<PtyAdapter.PtyProcess, BoxPtyError>;
  }
>()("t3/terminal/BoxPty") {}

const openError = () => new BoxPtyError({ message: "Could not open the thread’s Box terminal." });

export const layer = Layer.effect(
  BoxPty,
  Effect.gen(function* () {
    const resolver = yield* BoxThreadResolver;
    const api = yield* BoxApi.BoxApi;
    return BoxPty.of({
      spawn: Effect.fn("BoxPty.spawn")(function* (input) {
        const threadId = ThreadId.make(input.threadId);
        const target = yield* resolver.resolveTerminal(threadId).pipe(Effect.mapError(openError));
        if (!target) {
          return yield* new BoxPtyError({
            message: "No Box is available for this thread. Start an agent turn first.",
          });
        }
        return yield* Effect.tryPromise({
          try: async (signal) => {
            const box = await api.get(target.nativeId, target.apiKey);
            if (!box.exec.session) throw openError();
            if ((await box.getStatus()).status === "paused") await box.resume();
            if (signal.aborted) throw openError();
            const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
            let initialOutput = "";
            let onData: ((data: string) => void) | undefined;
            const output = (text: string) => {
              if (!text) return;
              if (onData) onData(text);
              else initialOutput = (initialOutput + text).slice(-64 * 1024);
            };
            const directories = [
              ...(target.worktree ? [BoxApi.boxWorktreePath(threadId)] : []),
              BoxApi.BOX_REPOSITORY_PATH,
            ];
            const handle = await box.exec.session({
              argv: [
                "bash",
                "-c",
                'for directory in "$@"; do if cd -- "$directory" 2>/dev/null; then break; fi; done; export PATH="$HOME/.local/bin:$PATH"; exec bash -i',
                "bash",
                ...directories,
              ],
              cwd: BoxApi.BOX_WORKSPACE_PATH,
              tty: true,
              cols: input.cols,
              rows: input.rows,
              env: ["TERM=xterm-256color"],
              onStdout: (bytes) => output(decoder.decode(bytes, { stream: true })),
            });
            if (signal.aborted) {
              handle.close();
              throw openError();
            }
            const exited = handle
              .wait()
              .then(
                (exitCode) => exitCode,
                () => -1,
              )
              .then((exitCode): PtyAdapter.PtyExitEvent => {
                output(decoder.decode());
                handle.close();
                return { exitCode, signal: null };
              });
            const send = (operation: () => void) => {
              try {
                operation();
              } catch {
                handle.close();
                throw new Error("The Box terminal connection closed.");
              }
            };
            return {
              pid: handle.pid,
              write: (data) => send(() => handle.write(data)),
              resize: (cols, rows) => send(() => handle.resize(rows, cols)),
              kill: () => handle.close(),
              onData: (callback) => {
                onData = callback;
                if (initialOutput) callback(initialOutput);
                initialOutput = "";
                return () => {
                  onData = undefined;
                };
              },
              onExit: (callback) => {
                let subscribed = true;
                void exited.then((event) => {
                  if (subscribed) callback(event);
                });
                return () => {
                  subscribed = false;
                };
              },
            } satisfies PtyAdapter.PtyProcess;
          },
          catch: openError,
        });
      }),
    });
  }),
);
