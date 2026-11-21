import type { ThreadId } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export interface Target {
  readonly threadId: ThreadId;
  readonly projectRoot: string;
  readonly checkoutRoot: string;
}

const targetKey = (target: Target) => JSON.stringify(target);

export class VcsThreadTarget extends Context.Reference<Target | undefined>(
  "t3/vcs/VcsThreadTarget",
  { defaultValue: () => undefined },
) {}

/** Each Box owns its caches, locks and background subscribers, even when host cwd is shared. */
export const partition = Effect.fn("VcsThreadTarget.partition")(function* <T extends object, E, R>(
  make: Effect.Effect<T, E, R>,
) {
  const context = yield* Effect.context<R | Scope.Scope>();
  const local = yield* make;
  const targets = new Map<string, Target>();
  const instances = yield* Cache.makeWith(
    (key: string) =>
      make.pipe(Effect.provideService(VcsThreadTarget, targets.get(key)), Effect.provide(context)),
    { capacity: Number.POSITIVE_INFINITY, timeToLive: () => Duration.infinity },
  );
  const instance = Effect.gen(function* () {
    const target = yield* VcsThreadTarget;
    if (!target) return local;
    const key = targetKey(target);
    targets.set(key, target);
    return yield* Cache.get(instances, key);
  });
  return new Proxy(local, {
    get(object, key) {
      const member: unknown = Reflect.get(object, key);
      if (typeof member === "function") {
        return (...args: unknown[]) => {
          const result: unknown = Reflect.apply(member, object, args);
          if (Stream.isStream(result))
            return Stream.unwrap(
              Effect.map(
                instance,
                (service) =>
                  Reflect.apply(
                    Reflect.get(service, key) as (...args: unknown[]) => unknown,
                    service,
                    args,
                  ) as Stream.Stream<unknown>,
              ),
            );
          if (!Effect.isEffect(result)) return result;
          return Effect.flatMap(
            instance,
            (service) =>
              Reflect.apply(
                Reflect.get(service, key) as (...args: unknown[]) => unknown,
                service,
                args,
              ) as Effect.Effect<unknown>,
          );
        };
      }
      if (Stream.isStream(member)) {
        return Stream.unwrap(
          Effect.map(instance, (service) => Reflect.get(service, key) as Stream.Stream<unknown>),
        );
      }
      if (Effect.isEffect(member)) {
        return Effect.flatMap(
          instance,
          (service) => Reflect.get(service, key) as Effect.Effect<unknown>,
        );
      }
      return member;
    },
  });
});
