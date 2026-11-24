import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderTurnId } from "@t3tools/contracts";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type { BoxHandle } from "./BoxApi.ts";
import { BoxProviderProcessError, openBoxProviderProcess } from "./providerSessionProcess.ts";
import { decodeCall, decodeFrame, encodeCall, encodeFrame } from "./providerSessionWire.ts";
import { serveProviderSession } from "./serveProviderSession.ts";

function fixture(response: (line: string, emit: (line: string) => void) => void, eager = true) {
  const exited = Promise.withResolvers<number>();
  let closed = false;
  const exec: BoxHandle["exec"] = {
    command: async () => ({ stdout: "", exitCode: 0 }),
    session: async ({ onStdout }) => {
      const emit = (line: string) => {
        const bytes = new TextEncoder().encode(line);
        onStdout?.(bytes.subarray(0, 3));
        onStdout?.(bytes.subarray(3));
      };
      if (eager)
        emit(encodeFrame({ type: "ready", methods: ["startTurn", "interruptTurn"] }) + "\n");
      return {
        id: "exec",
        pid: 7,
        write: (data) => response(String(data), emit),
        resize: () => {},
        wait: () => exited.promise,
        close: () => {
          closed = true;
          exited.resolve(0);
        },
      };
    },
  };
  return { exec, closed: () => closed };
}

it.effect("exchanges fragmented session events and call replies over scoped Box exec", () =>
  Effect.gen(function* () {
    const event: ProviderAdapterV2Event = {
      type: "background_work.updated",
      driver: ProviderDriverKind.make("opencode"),
      providerTurnId: ProviderTurnId.make("turn"),
      pending: true,
    };
    const box = fixture((line, emit) => {
      const { method, id, payload } = decodeCall(line);
      assert.equal(method, "startTurn");
      emit(encodeFrame({ type: "event", event }) + "\n");
      emit(encodeFrame({ type: "result", id, value: payload }) + "\n");
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* openBoxProviderProcess(box, { argv: ["node", "worker.mjs"] });
        assert.deepEqual([...session.methods], ["startTurn", "interruptTurn"]);
        assert.deepEqual(yield* session.call("startTurn", { text: "你好" }), { text: "你好" });
        const events = yield* Stream.runCollect(Stream.take(session.events, 1));
        assert.deepEqual(events, [event]);
      }),
    );
    assert.isTrue(box.closed());
  }),
);

it.effect("closes the session and redacts invalid process frames", () =>
  Effect.gen(function* () {
    const box = fixture((_line, emit) => emit("private fixture\n"));
    const session = yield* openBoxProviderProcess(box, { argv: ["node", "worker.mjs"] });
    const error = yield* session
      .call("startTurn")
      .pipe(Effect.match({ onSuccess: () => undefined, onFailure: (error) => error }));
    assert.deepEqual(error, new BoxProviderProcessError({ reason: "protocol" }));
    assert.isTrue(box.closed());
  }).pipe(Effect.scoped),
);

it.effect("sends the startup input before awaiting a worker sign-in failure", () =>
  Effect.gen(function* () {
    const box = fixture((line, emit) => {
      assert.equal(line, '{"instanceId":"cursor"}\n');
      emit(encodeFrame({ type: "startup_failure", reason: "authentication" }) + "\n");
    }, false);
    const error = yield* openBoxProviderProcess(
      box,
      { argv: ["node", "worker.mjs"] },
      '{"instanceId":"cursor"}',
    ).pipe(
      Effect.scoped,
      Effect.match({ onSuccess: () => undefined, onFailure: (error) => error }),
    );
    assert.deepEqual(error, new BoxProviderProcessError({ reason: "authentication" }));
    assert.isTrue(box.closed());
  }),
);

it.effect("serves upstream runtime calls without advertising unavailable methods", () =>
  Effect.gen(function* () {
    const input = yield* Queue.unbounded<string>();
    const output = yield* Queue.unbounded<string>();
    yield* serveProviderSession(
      { events: Stream.never, startTurn: () => Effect.void },
      Stream.fromQueue(input),
      (line) => {
        Queue.offerUnsafe(output, line);
      },
    ).pipe(Effect.forkScoped);
    assert.deepEqual(decodeFrame(yield* Queue.take(output)), {
      type: "ready",
      methods: ["startTurn"],
    });
    yield* Queue.offer(input, encodeCall({ id: 1, method: "startTurn" }));
    assert.deepEqual(decodeFrame(yield* Queue.take(output)), { type: "result", id: 1 });
    yield* Queue.offer(input, encodeCall({ id: 2, method: "ensureThread" }));
    assert.deepEqual(decodeFrame(yield* Queue.take(output)), { type: "failure", id: 2 });
  }).pipe(Effect.scoped),
);
