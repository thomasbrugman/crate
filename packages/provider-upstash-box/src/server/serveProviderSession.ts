import type {
  ProviderAdapterV2Error,
  ProviderAdapterV2Event,
  ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { decodeCall, encodeFrame, type ProviderSessionFrame } from "./providerSessionWire.ts";
import { sessionPayload, sessionResult } from "./providerSessionPayload.ts";

const sessionMethods = [
  "ensureThread",
  "resumeThread",
  "injectHistory",
  "startTurn",
  "resumeTurn",
  "compactThread",
  "steerTurn",
  "applyModelSelection",
  "applyThreadTitle",
  "stopTask",
  "awaitBackgroundTasks",
  "interruptTurn",
  "stopSubagent",
  "unloadThread",
  "respondToRuntimeRequest",
  "readThreadSnapshot",
  "uploadFeedback",
  "rollbackThread",
  "forkThread",
] as const satisfies ReadonlyArray<keyof ProviderAdapterV2SessionRuntime>;

export const serveProviderSession = Effect.fn("UpstashBox.serveProviderSession")(function* (
  runtime: Pick<ProviderAdapterV2SessionRuntime, "events"> &
    Partial<
      Pick<ProviderAdapterV2SessionRuntime, (typeof sessionMethods)[number] | "providerSession">
    >,
  input: Stream.Stream<string>,
  write: (line: string) => void,
  authenticationRequired?: (failure: unknown) => boolean,
) {
  type Handler = (payload: never) => Effect.Effect<unknown, ProviderAdapterV2Error>;
  const methods = new Map<string, Handler>();
  for (const method of sessionMethods) {
    const handle: Handler | undefined = runtime[method];
    if (handle) methods.set(method, (payload) => handle.call(runtime, payload));
  }
  const send = (frame: ProviderSessionFrame) => Effect.sync(() => write(encodeFrame(frame) + "\n"));
  const sendEvent = (event: ProviderAdapterV2Event) => send({ type: "event", event });
  yield* send({
    type: "ready",
    methods: [...methods.keys()],
    ...(runtime.providerSession === undefined ? {} : { providerSession: runtime.providerSession }),
  });
  yield* Stream.runForEach(input, (line) =>
    Effect.gen(function* () {
      const request = decodeCall(line);
      const handle = methods.get(request.method);
      if (!handle) return yield* send({ type: "failure", id: request.id });
      yield* Effect.suspend(() =>
        handle(sessionPayload(request.method, request.payload, "decode") as never),
      ).pipe(
        Effect.flatMap((result) => {
          const value = sessionResult(request.method, result, "encode");
          return send({
            type: "result",
            id: request.id,
            ...(value === undefined ? {} : { value }),
          });
        }),
        Effect.catchCause((cause) =>
          send({
            type: "failure",
            id: request.id,
            ...(authenticationRequired?.(Cause.squash(cause)) ? { reason: "authentication" } : {}),
          }),
        ),
        Effect.forkScoped,
      );
    }),
  ).pipe(Effect.raceFirst(Stream.runForEach(runtime.events, sendEvent)), Effect.scoped);
});
