import { assert, it } from "@effect/vitest";
import { BoxError } from "@upstash/box";
import * as Effect from "effect/Effect";

import { BoxApi } from "./BoxApi.ts";
import { probe } from "./driver.ts";

it.effect(
  "reports missing keys, successful API authentication, rejected keys and connection failures",
  () =>
    Effect.gen(function* () {
      for (const [key, error, status, auth] of [
        ["", null, "warning", "unauthenticated"],
        ["key", null, "ready", "authenticated"],
        ["key", new BoxError("private auth error", 401), "error", "unauthenticated"],
        ["key", new Error("private network error"), "error", "unknown"],
      ] as const) {
        let probes = 0;
        const result = yield* probe(key).pipe(
          Effect.provideService(BoxApi, {
            get: async () => {
              throw new Error("Unexpected get");
            },
            create: async () => {
              throw new Error("Unexpected create");
            },
            list: async () => {
              probes++;
              if (error) throw error;
              return [];
            },
          }),
        );
        assert.equal(result.status, status);
        assert.equal(result.auth.status, auth);
        assert.equal(probes, key ? 1 : 0);
        assert.notInclude(JSON.stringify(result), "private");
      }
    }),
);
