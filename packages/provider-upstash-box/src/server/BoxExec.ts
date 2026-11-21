import { type OrchestrationV2ProviderThread, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { BoxApi, isMissingBox, layer as boxApiLayer } from "./BoxApi.ts";

export class BoxExecError extends Schema.TaggedError<BoxExecError>()("BoxExecError", {
  threadId: ThreadId,
  reason: Schema.Literals([
    "thread_unavailable",
    "not_box_thread",
    "box_unavailable",
    "resolve_failed",
    "invalid_input",
    "exec_failed",
    "missing_exit_code",
  ]),
}) {}

export interface BoxExecThread {
  readonly providerThread: Pick<
    OrchestrationV2ProviderThread,
    "appThreadId" | "driver" | "nativeThreadRef"
  >;
  readonly apiKey: string;
  readonly repositoryUrl: string | null;
}

/** Loads the current persisted provider thread and its resolved provider-instance credentials.
 * Deleted threads must resolve to null. */
export class BoxExecThreadResolver extends Context.Service<
  BoxExecThreadResolver,
  {
    readonly resolve: (threadId: ThreadId) => Effect.Effect<BoxExecThread | null, BoxExecError>;
  }
>()("@t3tools/provider-upstash-box/server/BoxExec/BoxExecThreadResolver") {}

export interface BoxExecInput {
  readonly threadId: ThreadId;
  /** Shell source, with optional literal arguments appended to it. */
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
}

export interface BoxExecOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class BoxExec extends Context.Service<
  BoxExec,
  { readonly run: (input: BoxExecInput) => Effect.Effect<BoxExecOutput, BoxExecError> }
>()("@t3tools/provider-upstash-box/server/BoxExec") {}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export const make = Effect.gen(function* () {
  const resolver = yield* BoxExecThreadResolver;
  const api = yield* BoxApi;
  return BoxExec.of({
    run: Effect.fn("BoxExec.run")(function* (input) {
      const fail = (reason: BoxExecError["reason"]) =>
        new BoxExecError({ threadId: input.threadId, reason });
      if (
        !input.command.trim() ||
        [input.command, input.cwd ?? "", ...(input.args ?? [])].some((value) =>
          value.includes("\0"),
        ) ||
        (input.cwd !== undefined && !input.cwd.startsWith("/"))
      )
        return yield* fail("invalid_input");
      const thread = yield* resolver
        .resolve(input.threadId)
        .pipe(Effect.mapError(() => fail("resolve_failed")));
      if (!thread) return yield* fail("thread_unavailable");
      const persisted = thread.providerThread;
      if (
        persisted.appThreadId !== input.threadId ||
        persisted.driver !== "upstashBox" ||
        persisted.nativeThreadRef?.driver !== "upstashBox"
      )
        return yield* fail("not_box_thread");
      const nativeId = persisted.nativeThreadRef.nativeId;
      if (!nativeId || !thread.apiKey) return yield* fail("box_unavailable");
      const box = yield* Effect.tryPromise({
        try: () => api.get(nativeId, thread.apiKey),
        catch: () => fail("box_unavailable"),
      });
      const cwd = input.cwd ?? (thread.repositoryUrl ? "/workspace/home/repo" : "/workspace/home");
      const command = [input.command, ...(input.args ?? []).map(quote)].join(" ");
      const result = yield* Effect.tryPromise({
        try: () => box.exec.command(`cd -- ${quote(cwd)} || exit 1\n${command}`),
        catch: (error) => fail(isMissingBox(error) ? "box_unavailable" : "exec_failed"),
      });
      if (result.exitCode === null) return yield* fail("missing_exit_code");
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr ?? "" };
    }),
  });
});

export const layer = Layer.effect(BoxExec, make).pipe(Layer.provide(boxApiLayer));
