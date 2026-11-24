// @effect-diagnostics nodeBuiltinImport:off -- The Box exec callbacks supply stdout bytes, not a stream.
import * as NodeReadline from "node:readline";
import * as NodeStream from "node:stream";
import type { OrchestrationV2ProviderSession } from "@t3tools/contracts";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import type { ExecSessionOptions } from "@upstash/box";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { BoxHandle } from "./BoxApi.ts";
import { decodeFrame, encodeCall } from "./providerSessionWire.ts";

export class BoxProviderProcessError extends Schema.TaggedError<
  BoxProviderProcessError,
  { readonly brand: unique symbol }
>()("BoxProviderProcessError", {
  reason: Schema.Literals(["launch", "closed", "protocol", "request_failed", "authentication"]),
}) {}

type Ready =
  | {
      readonly type: "ready";
      readonly methods: ReadonlySet<string>;
      readonly providerSession: OrchestrationV2ProviderSession | undefined;
    }
  | { readonly type: "failed"; readonly error: BoxProviderProcessError };
const isBoxProviderProcessError = Schema.is(BoxProviderProcessError);

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: BoxProviderProcessError) => void;
}

export const openBoxProviderProcess = Effect.fn("UpstashBox.openProviderProcess")(function* (
  box: Pick<BoxHandle, "exec">,
  launch: Pick<ExecSessionOptions, "argv" | "cwd" | "env">,
  initialize?: string,
) {
  const events = yield* Queue.make<ProviderAdapterV2Event, BoxProviderProcessError>();
  const spawn = box.exec.session;
  if (!spawn) return yield* new BoxProviderProcessError({ reason: "launch" });
  const output = new NodeStream.Readable({ read() {} });
  const pending = new Map<number, PendingCall>();
  const ready = Promise.withResolvers<Ready>();
  let methods: ReadonlySet<string> | undefined;
  let closed: BoxProviderProcessError | undefined;

  const session = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => spawn({ ...launch, onStdout: (bytes) => output.push(bytes) }),
      catch: () => new BoxProviderProcessError({ reason: "launch" }),
    }).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          output.destroy();
        }),
      ),
    ),
    (session) =>
      Effect.sync(() => {
        close("closed");
        session.close();
      }),
  );

  function close(reason: typeof BoxProviderProcessError.prototype.reason) {
    if (closed) return;
    closed = new BoxProviderProcessError({ reason });
    ready.resolve({ type: "failed", error: closed });
    for (const call of pending.values()) call.reject(closed);
    pending.clear();
    Queue.failCauseUnsafe(events, Cause.fail(closed));
    output.destroy();
  }

  const reader = NodeReadline.createInterface({ input: output, crlfDelay: Infinity });
  reader.on("line", (line) => {
    if (closed) return;
    try {
      const frame = decodeFrame(line);
      if (frame.type === "startup_failure") {
        close(frame.reason);
      } else if (frame.type === "ready") {
        if (methods) throw new Error();
        methods = new Set(frame.methods);
        ready.resolve({ type: "ready", methods, providerSession: frame.providerSession });
      } else if (frame.type === "event") {
        if (!methods) throw new Error();
        Queue.offerUnsafe(events, frame.event);
      } else {
        const call = pending.get(frame.id);
        if (!call) return;
        pending.delete(frame.id);
        if (frame.type === "result") call.resolve(frame.value);
        else call.reject(new BoxProviderProcessError({ reason: frame.reason ?? "request_failed" }));
      }
    } catch {
      close("protocol");
      session.close();
    }
  });
  void session.wait().then(
    () => close("closed"),
    () => close("closed"),
  );
  if (initialize !== undefined) {
    yield* Effect.try({
      try: () => session.write(initialize + "\n"),
      catch: () => new BoxProviderProcessError({ reason: "launch" }),
    });
  }
  const startup = yield* Effect.promise(() => ready.promise);
  if (startup.type === "failed") return yield* startup.error;
  const available = startup.methods;

  let nextId = 0;
  const call = (method: string, payload?: unknown) =>
    Effect.tryPromise({
      try: (signal) => {
        if (closed) throw closed;
        if (!available.has(method)) throw new BoxProviderProcessError({ reason: "protocol" });
        const id = ++nextId;
        const line = encodeCall({ id, method, ...(payload === undefined ? {} : { payload }) });
        const reply = Promise.withResolvers<unknown>();
        const abort = () => {
          pending.delete(id);
          reply.reject(new BoxProviderProcessError({ reason: "closed" }));
        };
        if (signal.aborted) throw new BoxProviderProcessError({ reason: "closed" });
        signal.addEventListener("abort", abort, { once: true });
        pending.set(id, reply);
        try {
          session.write(line + "\n");
        } catch {
          close("closed");
          session.close();
        }
        return reply.promise.finally(() => signal.removeEventListener("abort", abort));
      },
      catch: (error) =>
        isBoxProviderProcessError(error)
          ? error
          : new BoxProviderProcessError({ reason: "protocol" }),
    });

  return {
    call,
    methods: available,
    providerSession: startup.providerSession,
    events: Stream.fromQueue(events),
  };
});
