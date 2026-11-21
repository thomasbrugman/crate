import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as RcMap from "effect/RcMap";
import * as Stream from "effect/Stream";

export interface Target {
  readonly threadId: ThreadId;
  readonly projectRoot: string;
  readonly checkoutRoot: string;
}

class TargetKey extends Data.Class<Target> {}

export class VcsThreadTarget extends Context.Reference<Target | undefined>(
  "t3/vcs/VcsThreadTarget",
  { defaultValue: () => undefined },
) {}

/** Each Box owns its caches, locks and background subscribers, even when host cwd is shared. */
export const partition = Effect.fn("VcsThreadTarget.partition")(function* <T extends object, E, R>(
  make: Effect.Effect<T, E, R>,
) {
  const local = yield* make;
  const instances = yield* RcMap.make({
    lookup: (target: Target) => make.pipe(Effect.provideService(VcsThreadTarget, target)),
    idleTimeToLive: Duration.minutes(5),
  });
  const instance = Effect.gen(function* () {
    const target = yield* VcsThreadTarget;
    if (!target) return local;
    return yield* RcMap.get(instances, new TargetKey(target));
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
          return Effect.scoped(
            Effect.flatMap(
              instance,
              (service) =>
                Reflect.apply(
                  Reflect.get(service, key) as (...args: unknown[]) => unknown,
                  service,
                  args,
                ) as Effect.Effect<unknown>,
            ),
          );
        };
      }
      if (Stream.isStream(member)) {
        return Stream.unwrap(
          Effect.map(instance, (service) => Reflect.get(service, key) as Stream.Stream<unknown>),
        );
      }
      if (Effect.isEffect(member)) {
        return Effect.scoped(
          Effect.flatMap(
            instance,
            (service) => Reflect.get(service, key) as Effect.Effect<unknown>,
          ),
        );
      }
      return member;
    },
  });
});
