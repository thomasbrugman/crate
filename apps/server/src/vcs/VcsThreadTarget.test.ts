import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { partition, VcsThreadTarget } from "./VcsThreadTarget.ts";

it.effect("releases idle thread services but retains active calls and streams", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const closed: number[] = [];
      let created = 0;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const service = yield* partition(
        Effect.gen(function* () {
          const id = ++created;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closed.push(id);
            }),
          );
          return {
            id: Effect.succeed(id),
            fail: () => Effect.fail("expected"),
            wait: () =>
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
            stream: Stream.make(id),
          };
        }),
      );
      const target = {
        threadId: ThreadId.make("idle-thread"),
        projectRoot: "/host",
        checkoutRoot: "/box",
      };
      const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provideService(VcsThreadTarget, { ...target }));
      const original = yield* run(service.id);
      assert.equal(yield* run(service.id), original);
      assert.deepEqual(yield* run(Stream.runCollect(service.stream)), [original]);
      const active = yield* run(service.wait()).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("6 minutes");
      assert.notInclude(closed, original);
      assert.equal(yield* run(service.id), original);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(active);
      yield* TestClock.adjust("6 minutes");
      assert.include(closed, original);
      assert.notEqual(yield* run(service.id), original);
      assert.equal(yield* service.id, 1);
      const errorInstance = yield* run(service.id);
      assert.equal(yield* run(service.fail()).pipe(Effect.flip), "expected");
      yield* TestClock.adjust("6 minutes");
      assert.include(closed, errorInstance);
    }),
  ),
);
