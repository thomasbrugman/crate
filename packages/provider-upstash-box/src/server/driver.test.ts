import { assert, it } from "@effect/vitest";
import { BoxError } from "@upstash/box";
import * as Effect from "effect/Effect";

import type { BoxHarness } from "../harnesses.ts";
import { BoxApi } from "./BoxApi.ts";
import { probe } from "./driver.ts";

it.effect("reports whether the Box key and the harness's model key can start a run", () =>
  Effect.gen(function* () {
    for (const [key, error, harness, agentApiKey, modelStatus, status, auth] of [
      ["", null, "commandCode", "", null, "warning", "unauthenticated"],
      ["key", null, "commandCode", "", null, "ready", "authenticated"],
      [
        "key",
        new BoxError("private auth error", 401),
        "claudeCode",
        "sk",
        200,
        "error",
        "unauthenticated",
      ],
      ["key", new Error("private network error"), "commandCode", "", null, "error", "unknown"],
      ["key", null, "claudeCode", "", null, "warning", "authenticated"],
      ["key", null, "codex", "sk", 200, "ready", "authenticated"],
      ["key", null, "claudeCode", "sk", 401, "error", "unauthenticated"],
      ["key", null, "codex", "sk", 500, "warning", "authenticated"],
      ["key", null, "codex", "sk", new Error("private network error"), "warning", "authenticated"],
    ] as const) {
      let boxProbes = 0;
      let modelProbes = 0;
      const result = yield* probe(key, { harness: harness as BoxHarness, agentApiKey }).pipe(
        Effect.provideService(BoxApi, {
          get: async () => {
            throw new Error("Unexpected get");
          },
          create: async () => {
            throw new Error("Unexpected create");
          },
          list: async () => {
            boxProbes++;
            if (error) throw error;
            return [];
          },
          checkModelKey: async () => {
            modelProbes++;
            if (modelStatus instanceof Error) throw modelStatus;
            return modelStatus ?? 200;
          },
        }),
      );
      assert.equal(result.status, status);
      assert.equal(result.auth.status, auth);
      assert.equal(boxProbes, key ? 1 : 0);
      assert.equal(modelProbes, modelStatus !== null && !error ? 1 : 0);
      assert.notInclude(JSON.stringify(result), "private");
    }
  }),
);
