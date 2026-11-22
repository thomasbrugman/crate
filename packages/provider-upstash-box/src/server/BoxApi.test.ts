import { assert, it } from "@effect/vitest";
import { Box, BoxError } from "@upstash/box";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import { BoxApi, boxErrorDetails, layer } from "./BoxApi.ts";

it("keeps only sanitized diagnostic fields from SDK errors", () => {
  const sentinel = "sdk-credential-fixture";
  const metadata = { headers: { Authorization: sentinel }, apiKey: sentinel };
  const error = Object.assign(
    new BoxError(`Delete refused for ${sentinel}`, 503, { cause: metadata }),
    {
      request: metadata,
      response: metadata,
      ...metadata,
    },
  );
  const detail = boxErrorDetails(error, { boxId: "box" });
  assert.deepEqual(detail, {
    message: "Upstash Box request failed.",
    statusCode: 503,
    boxId: "box",
  });
  for (const input of [undefined, new Error(""), new BoxError(JSON.stringify(metadata))]) {
    const value = boxErrorDetails(input);
    assert.deepEqual(Object.keys(value), ["message"]);
    assert.isNotEmpty(value.message);
    assert.isFalse(JSON.stringify(value).includes(sentinel));
  }
});

it.effect("projects SDK handles and responses without retaining credential metadata", () =>
  Effect.gen(function* () {
    const sentinel = "sdk-credential-fixture";
    const metadata = { apiKey: sentinel, headers: { Authorization: sentinel } };
    const stream = {
      ...metadata,
      id: "run",
      cancel: async () => undefined,
      async *[Symbol.asyncIterator]() {
        yield { type: "text-delta" as const, text: "hello" };
      },
    };
    const native = {
      ...metadata,
      id: "box",
      agent: { stream: async () => stream },
      exec: { command: async () => ({ ...metadata, stdout: "safe", stderr: "", exitCode: 0 }) },
      files: { write: async () => metadata },
      browser: { cdpUrl: async () => "wss://browser.fixture/?token=fixture" },
      delete: async () => metadata,
      resume: async () => undefined,
      getStatus: async () => ({ ...metadata, status: "running" }),
    };
    using _get = vi.spyOn(Box, "get").mockResolvedValue(native as unknown as Box);
    using _list = vi.spyOn(Box, "list").mockResolvedValue([]);
    const api = yield* BoxApi;
    const box = yield* Effect.promise(() => api.get("box", sentinel));
    const run = yield* Effect.promise(() => box.agent.stream({ prompt: "hello" }));
    const command = yield* Effect.promise(() => box.exec.command("true"));
    const status = yield* Effect.promise(() => box.getStatus());
    for (const projected of [box, run, command, status]) {
      assert.isFalse(JSON.stringify(projected).includes(sentinel));
    }
    assert.isTrue(
      (yield* Effect.promise(() => box.files.write({ path: "/file", content: "ok" }))) ===
        undefined,
    );
    assert.isTrue((yield* Effect.promise(() => box.delete())) === undefined);
    assert.isTrue((yield* Effect.promise(() => api.list(sentinel))) === undefined);
    assert.equal(command.stdout, "safe");
    assert.equal(status.status, "running");
    assert.equal(
      yield* Effect.promise(() => box.browserCdpUrl!()),
      "wss://browser.fixture/?token=fixture",
    );
  }).pipe(Effect.provide(layer)),
);
