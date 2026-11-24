import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, SecretProviderId } from "@t3tools/contracts";
import { BoxError } from "@upstash/box";
import * as Effect from "effect/Effect";

import type { BoxHarness } from "../harnesses.ts";
import { BoxApi } from "./BoxApi.ts";
import { readGitHubToken, readHarnessCredentials } from "./credentials.ts";
import { probe } from "./driver.ts";
import { readBoxWorkerModels } from "./workerAdapter.ts";

it.effect("loads OpenCode models from a small Box with valid Upstash labels", () =>
  Effect.gen(function* () {
    const models = [{ slug: "opencode/model", name: "Model", isCustom: false, capabilities: null }];
    let deleted = false;
    const result = yield* readBoxWorkerModels("opencode", "box-key", "", async () => "worker").pipe(
      Effect.provideService(BoxApi, {
        get: async () => {
          throw new Error("Unexpected get");
        },
        create: async ({ labels, size }) => {
          assert.equal(size, "small");
          assert.isNotEmpty(labels ?? []);
          if (labels?.some((label) => !/^[A-Za-z0-9._:-]{1,20}$/u.test(label))) {
            throw new BoxError("Invalid Box label", 400);
          }
          return {
            id: "catalog-box",
            agent: {
              stream: async () => {
                throw new Error("Unexpected agent stream");
              },
            },
            exec: {
              command: async (command) => ({
                exitCode: 0,
                stdout: command.endsWith(" opencode catalog") ? JSON.stringify(models) : "",
              }),
            },
            files: { write: async () => {}, writeVolatile: async () => {} },
            delete: async () => {
              deleted = true;
            },
            resume: async () => {},
            getStatus: async () => ({ status: "idle" }),
          };
        },
        list: async () => [],
        checkModelKey: async () => 200,
      }),
    );
    assert.deepEqual(result, models);
    assert.isTrue(deleted);
  }),
);

it.effect("resolves vault-backed harness credentials alongside pasted ones", () =>
  Effect.gen(function* () {
    const provider = SecretProviderId.make("vault");
    const credentials = yield* readHarnessCredentials(
      {
        ...DEFAULT_SERVER_SETTINGS.upstashBox,
        commandCodeAuth: "fixture-key",
        claudeCodeAuth: { provider, reference: "op://fixture/claude" },
        codexAuth: { provider, reference: "op://fixture/missing" },
        opencodeAuth: '{"provider":{"type":"api","key":"fixture"}}',
        cursorAuth: { provider, reference: "op://fixture/cursor" },
        antigravityAuth: "fixture-gemini-key",
      },
      (ref) =>
        Effect.succeed(
          ref.reference.endsWith("/claude")
            ? "fixture-oauth"
            : ref.reference.endsWith("/cursor")
              ? "fixture-cursor-key"
              : undefined,
        ),
    );
    assert.deepEqual(credentials, {
      commandCode: "fixture-key",
      claudeCode: "fixture-oauth",
      codex: "",
      opencode: '{"provider":{"type":"api","key":"fixture"}}',
      cursor: "fixture-cursor-key",
      antigravity: "fixture-gemini-key",
    });
  }),
);

it.effect("only uses the saved, enabled github.com token for a Box", () =>
  Effect.gen(function* () {
    const provider = SecretProviderId.make("vault");
    const reference = { provider, reference: "op://fixture/github" };
    for (const [github, token] of [
      [{ tokens: { "github.com": reference } }, "vault-token"],
      [{ tokens: { "github.com": "paste-token" } }, "paste-token"],
      [{ tokens: { "github.example": "other-token" } }, ""],
      [{ tokens: { "github.com": reference }, hosts: { "github.com": { enabled: false } } }, ""],
    ] as const) {
      const actual = yield* readGitHubToken(
        { ...DEFAULT_SERVER_SETTINGS, sourceControlHosts: { github } },
        (ref) => Effect.succeed(ref.reference === reference.reference ? "vault-token" : undefined),
      );
      assert.equal(actual, token);
    }
  }),
);

it.effect("reports whether the Box key and the harness's model key can start a run", () =>
  Effect.gen(function* () {
    for (const [key, error, harness, agentApiKey, modelStatus, status, auth] of [
      ["", null, "commandCode", "", null, "warning", "unauthenticated"],
      ["key", null, "commandCode", '{"token":"fixture"}', null, "ready", "authenticated"],
      [
        "key",
        new BoxError("private auth error", 401),
        "claudeCode",
        "sk",
        200,
        "error",
        "unauthenticated",
      ],
      [
        "key",
        new Error("private network error"),
        "commandCode",
        '{"token":"fixture"}',
        null,
        "error",
        "unknown",
      ],
      ["key", null, "claudeCode", "", null, "warning", "unauthenticated"],
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
      assert.equal(boxProbes, key && agentApiKey ? 1 : 0);
      assert.equal(modelProbes, modelStatus !== null && !error ? 1 : 0);
      assert.notInclude(JSON.stringify(result), "private");
    }
  }),
);
