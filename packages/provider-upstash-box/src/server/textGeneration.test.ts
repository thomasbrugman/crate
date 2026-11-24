import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import type { Chunk } from "@upstash/box";
import * as Effect from "effect/Effect";

import { BoxApi, type BoxHandle } from "./BoxApi.ts";
import {
  makeBoxTextGeneration,
  structuredPrompt,
  textGenerationBoxName,
} from "./textGeneration.ts";

function fakeBox(chunks: ReadonlyArray<Chunk>) {
  const prompts: string[] = [];
  const names: string[] = [];
  const box: BoxHandle = {
    id: "box-text",
    agent: {
      stream: async ({ prompt }) => {
        prompts.push(prompt);
        return {
          id: "run-1",
          cancel: async () => undefined,
          async *[Symbol.asyncIterator]() {
            yield* chunks;
          },
        };
      },
    },
    exec: { command: async () => ({ stdout: "", exitCode: 0 }) },
    files: { write: async () => undefined },
    delete: async () => undefined,
    resume: async () => undefined,
    getStatus: async () => ({ status: "idle" }),
  };
  const api = {
    get: async (name: string) => {
      names.push(name);
      return box;
    },
    create: async () => box,
    list: async () => [],
    checkModelKey: async () => 200,
  };
  return { api, prompts, names };
}

const generate = (chunks: ReadonlyArray<Chunk>) =>
  Effect.gen(function* () {
    const fake = fakeBox(chunks);
    const textGeneration = yield* makeBoxTextGeneration(
      "commandCode",
      "",
      Effect.succeed({ apiKey: "test-key", templateBoxName: "cc-harness", size: "medium" }),
    ).pipe(Effect.provideService(BoxApi, fake.api));
    const result = yield* textGeneration
      .generateThreadTitle({
        cwd: "/workspace/home/repo",
        message: "the login button does nothing on mobile",
        modelSelection: { instanceId: ProviderInstanceId.make("boxCommandCode"), model: "default" },
      })
      .pipe(Effect.match({ onFailure: (error) => error, onSuccess: (result) => result }));
    return { ...fake, result };
  });

it.effect("generates a thread title from the harness reply in the shared text Box", () =>
  Effect.gen(function* () {
    const { result, prompts, names } = yield* generate([
      { type: "text-delta", text: 'Sure: {"title": ' } as Chunk,
      { type: "text-delta", text: '"Fix mobile login button"}' } as Chunk,
      { type: "finish", output: "ignored", sessionId: "s" } as Chunk,
    ]);
    assert.deepEqual(result, { title: "Fix mobile login button" });
    assert.deepEqual(names, [textGenerationBoxName("commandCode")]);
    assert.include(prompts[0], "the login button does nothing on mobile");
    assert.include(prompts[0], '"title"');
  }),
);

it.effect("falls back to the finish output and rejects replies without JSON", () =>
  Effect.gen(function* () {
    const fromFinish = yield* generate([
      { type: "finish", output: '{"title":"Fix login"}', sessionId: "s" } as Chunk,
    ]);
    assert.deepEqual(fromFinish.result, { title: "Fix login" });
    const invalid = yield* generate([{ type: "text-delta", text: "no idea" } as Chunk]);
    assert.instanceOf(invalid.result, TextGenerationError);
  }),
);

it("keeps structured prompts under the shell argument limit", () => {
  const prompt = structuredPrompt("é".repeat(100_000), { type: "object" });
  assert.isBelow(Buffer.byteLength(prompt), 128 * 1024);
  assert.notInclude(prompt, "\uFFFD");
  assert.isTrue(prompt.endsWith('{"type":"object"}'));
});
