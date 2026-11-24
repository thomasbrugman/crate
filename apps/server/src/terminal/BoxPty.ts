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
  cause: Schema.optional(Schema.Defect()),
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

function openError(cause: unknown, apiKey?: string): BoxPtyError {
  const redact = (text: string) => (apiKey ? text.replaceAll(apiKey, "[redacted]") : text);
  const plainError =
    cause instanceof Error &&
    Object.getPrototypeOf(cause) === Error.prototype &&
    Reflect.ownKeys(cause).every((key) => key === "message" || key === "stack") &&
    (!apiKey || !cause.stack?.includes(apiKey)) &&
    (!apiKey || !cause.message.includes(apiKey));
  const statusCode = cause instanceof Error ? BoxApi.boxErrorDetails(cause).statusCode : undefined;
  return new BoxPtyError({
    message: "Could not open the thread’s Box terminal.",
    cause: plainError
      ? cause
      : {
          name: cause instanceof Error ? redact(cause.name) : "Error",
          message: redact(
            cause instanceof Error ? cause.message : "Unknown Box terminal startup failure.",
          ),
          ...(statusCode === undefined ? {} : { statusCode }),
        },
  });
}

export const layer = Layer.effect(
  BoxPty,
  Effect.gen(function* () {
    const resolver = yield* BoxThreadResolver;
    const api = yield* BoxApi.BoxApi;
    return BoxPty.of({
      spawn: Effect.fn("BoxPty.spawn")(function* (input) {
        const threadId = ThreadId.make(input.threadId);
        const target = yield* resolver
          .resolveTerminal(threadId)
          .pipe(Effect.mapError((cause) => openError(cause)));
        if (!target) {
          return yield* new BoxPtyError({
            message: "No Box is available for this thread. Start an agent turn first.",
          });
        }
        return yield* Effect.tryPromise({
          try: async (signal) => {
            const box = await api.get(target.nativeId, target.apiKey);
            if (!box.exec.session) throw new Error("The Box does not support terminal sessions.");
            if ((await box.getStatus()).status === "paused") await box.resume();
            if (signal.aborted) throw signal.reason;
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
                'for directory in "$@"; do if cd -- "$directory" 2>/dev/null; then break; fi; done; export PATH="$HOME/.local/bin:$PATH"; if test -e .git; then export T3CODE_PROJECT_ROOT="$0" T3CODE_WORKTREE_PATH="$PWD"; fi; exec bash -i',
                BoxApi.BOX_REPOSITORY_PATH,
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
              throw signal.reason;
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
          catch: (cause) => openError(cause, target.apiKey),
        });
      }),
    });
  }),
);
