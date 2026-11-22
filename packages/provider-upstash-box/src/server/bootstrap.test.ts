import { assert, it } from "@effect/vitest";
import { Agent, BoxApiKey, BoxError, type BoxConfig } from "@upstash/box";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import { vi } from "vite-plus/test";

import { BoxApi, type BoxHandle } from "./BoxApi.ts";
import { ensureBox } from "./bootstrap.ts";
import { commandCodeHarness } from "./harness.ts";

it.effect(
  "classifies authentication failures without retaining SDK errors or calling with no key",
  () =>
    Effect.gen(function* () {
      for (const [apiKey, status, create] of [
        ["", undefined, false],
        ["   ", undefined, false],
        ["key", 401, false],
        ["key", 403, true],
        ["key", 500, false],
      ] as const) {
        let calls = 0;
        const error = yield* ensureBox(
          {
            apiKey,
            templateBoxName: "template",
            size: "small",
            model: "",
            harness: "commandCode",
            agentApiKey: "",
          },
          "thread-box",
        ).pipe(
          Effect.provideService(BoxApi, {
            get: async () => {
              calls++;
              throw new BoxError("private upstream body", create ? 404 : status);
            },
            create: async () => {
              calls++;
              throw new BoxError("private upstream body", status);
            },
            list: async () => [],
            checkModelKey: async () => {
              throw new Error("unexpected model key check");
            },
          }),
          Effect.flip,
        );
        assert.equal(error.statusCode, status);
        assert.equal(calls, apiKey.trim() ? (create ? 2 : 1) : 0);
        assert.notInclude(JSON.stringify(error), "private upstream body");
      }
    }),
);

it.effect(
  "bootstraps credentials and repositories once, supports no remote, and sanitizes clone failures",
  () =>
    Effect.gen(function* () {
      for (const [repositoryUrl, fails] of [
        [undefined, false],
        ["https://github.com/owner/repo.git", false],
        ["https://github.com/owner/repo.git", true],
      ] as const) {
        const created: BoxConfig[] = [];
        let ready = false;
        let clones = 0;
        const commands: string[] = [];
        const writes: string[] = [];
        const harnesses: string[] = [];
        const steps: string[] = [];
        const box: BoxHandle = {
          id: "box-bootstrap",
          agent: {
            stream: async () => {
              throw new Error("unexpected agent call");
            },
          },
          exec: {
            command: async (command) => {
              commands.push(command);
              if (command.startsWith("test -f")) return { stdout: "", exitCode: ready ? 0 : 1 };
              if (command.includes("git clone --")) {
                clones++;
                if (fails) throw new Error("private credentials in SDK request");
              }
              if (command.startsWith("chmod 600 /home/boxuser/.commandcode")) ready = true;
              return { stdout: "", exitCode: 0 };
            },
          },
          files: {
            write: async ({ path, content }) => {
              writes.push(path);
              if (path.endsWith("t3stash-harness.mjs")) harnesses.push(content);
            },
          },
          delete: async () => undefined,
          resume: async () => undefined,
          getStatus: async () => ({ status: "idle" }),
        };
        const api = {
          get: async (id: string) => {
            if (id === "template")
              return {
                ...box,
                exec: {
                  command: async () => ({ stdout: "private template credentials", exitCode: 0 }),
                },
              };
            if (!created.length) throw new BoxError("missing", 404);
            return box;
          },
          create: async (config: BoxConfig) => {
            created.push(config);
            return box;
          },
          list: async () => [],
          checkModelKey: async () => 200,
        };
        const bootstrap = ensureBox(
          {
            apiKey: "key",
            templateBoxName: "template",
            size: "small",
            harness: "commandCode",
            model: "default",
            agentApiKey: "",
          },
          "thread-box",
          repositoryUrl,
          (step) => steps.push(step),
        ).pipe(Effect.provideService(BoxApi, api));
        if (fails) {
          const error = yield* bootstrap.pipe(Effect.flip);
          assert.equal(error.operation, "bootstrap");
          assert.notInclude(JSON.stringify(error), "private");
        } else {
          yield* bootstrap;
          yield* bootstrap;
          assert.deepEqual(steps, [
            "connect",
            "create",
            "check",
            "install",
            "credentials",
            ...(repositoryUrl ? ["clone"] : []),
            "connect",
            "check",
          ]);
          assert.equal(clones, repositoryUrl ? 1 : 0);
          assert.isFalse(writes.some((path) => /\.git(?:-credentials|config)$/u.test(path)));
          assert.deepEqual(harnesses, [commandCodeHarness, commandCodeHarness]);
        }
        assert.equal(
          created[0]?.env?.BOXJOB_CC_CWD,
          repositoryUrl ? "/workspace/home/repo" : "/workspace/home",
        );
      }
    }),
);

it.effect("bootstraps a managed agent Box without installing Command Code", () =>
  Effect.gen(function* () {
    const created: BoxConfig[] = [];
    const commands: string[] = [];
    let bootstrapped = false;
    let clones = 0;
    const box: BoxHandle = {
      id: "box-claude",
      resume: async () => undefined,
      getStatus: async () => ({ status: "idle" }),
      agent: {
        stream: async () => {
          throw new Error("unexpected agent call");
        },
      },
      exec: {
        command: async (command) => {
          commands.push(command);
          if (command.startsWith("test -f")) return { stdout: "", exitCode: bootstrapped ? 0 : 1 };
          if (command.startsWith("touch ")) bootstrapped = true;
          if (command.includes("git clone --")) clones++;
          return { stdout: "", exitCode: 0 };
        },
      },
      files: { write: async () => undefined },
      delete: async () => undefined,
    };
    const api = {
      get: async (id: string) => {
        if (id === "template") return box;
        if (!created.length) throw new BoxError("missing", 404);
        return box;
      },
      create: async (config: BoxConfig) => {
        created.push(config);
        return box;
      },
      list: async () => [],
      checkModelKey: async () => 200,
    };
    const bootstrap = ensureBox(
      {
        apiKey: "key",
        templateBoxName: "template",
        size: "medium",
        harness: "claudeCode",
        model: "anthropic/claude-opus-5",
        agentApiKey: "",
      },
      "thread-box",
      "https://github.com/owner/repo.git",
    ).pipe(Effect.provideService(BoxApi, api));
    const bootstrapWithoutRepository = ensureBox(
      {
        apiKey: "key",
        templateBoxName: "template",
        size: "medium",
        harness: "claudeCode",
        model: "anthropic/claude-opus-5",
        agentApiKey: "",
      },
      "thread-box",
    ).pipe(Effect.provideService(BoxApi, api));
    yield* bootstrap;
    yield* bootstrap;
    yield* bootstrapWithoutRepository;
    assert.deepEqual(created[0]?.agent, {
      harness: Agent.ClaudeCode,
      model: "anthropic/claude-opus-5",
      apiKey: BoxApiKey.StoredKey,
    });
    assert.equal(created[0]?.size, "medium");
    assert.isUndefined(created[0]?.env);
    assert.isFalse(commands.some((command) => command.includes("command-code")));
    assert.equal(clones, 1);
    bootstrapped = false;
    yield* bootstrapWithoutRepository;
    assert.isFalse(commands.some((command) => command.includes("cat ~/.git")));
    assert.equal(clones, 1);
  }),
);

it.effect.each([
  { snapshotId: undefined, profileStatus: 200 },
  { snapshotId: "snapshot-fixture", profileStatus: 200 },
  { snapshotId: undefined, profileStatus: 401 },
  { snapshotId: "snapshot-fixture", profileStatus: 503 },
  { snapshotId: undefined, profileStatus: null },
])(
  "prepares volatile Git and harness credentials before cloning (snapshot $snapshotId, GitHub profile status $profileStatus)",
  ({ snapshotId, profileStatus }) =>
    Effect.gen(function* () {
      let created: BoxConfig | undefined;
      let restored: string | undefined;
      const commands: string[] = [];
      const templateReads: string[] = [];
      const files = new Map<string, string>();
      const volatile = new Map<string, string>();
      const warnings: unknown[] = [];
      using githubUser = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        if (profileStatus === null) throw new Error("fixture-github-token");
        return profileStatus === 200
          ? Response.json({ id: 123, login: "fixture-login", name: "Fixture O'Name", email: null })
          : new Response("fixture-github-token", { status: profileStatus });
      });
      const box: BoxHandle = {
        id: "shared-box",
        resume: async () => undefined,
        getStatus: async () => ({ status: "idle" }),
        agent: {
          stream: async () => {
            throw new Error("unexpected managed agent");
          },
        },
        exec: {
          command: async (command) => {
            commands.push(command);
            if (command.includes("git clone"))
              assert.equal(
                volatile.get("/dev/shm/t3stash-git/credential"),
                "username=x-access-token\npassword=fixture-github-token\n",
              );
            return {
              stdout: "",
              exitCode: command.startsWith("test -f") || command.startsWith("test -s") ? 1 : 0,
            };
          },
        },
        files: {
          write: async ({ path, content }) => {
            files.set(path, content);
          },
          writeVolatile: async (path, content) => {
            volatile.set(path, content);
          },
        },
        delete: async () => undefined,
      };
      const credentials = {
        commandCode: '{"token":"command-fixture"}',
        claudeCode: "sk-ant-oat-test",
        codex: "codex-key-fixture",
      };
      yield* ensureBox(
        {
          apiKey: "key",
          templateBoxName: "template",
          size: "small",
          harness: "codex",
          model: "default",
          agentApiKey: "",
          credentials,
          githubToken: "fixture-github-token",
          ...(snapshotId ? { snapshotId } : {}),
        },
        "thread",
        "https://github.com/owner/repo.git",
      ).pipe(
        Effect.provideService(BoxApi, {
          get: async (id) => {
            if (id !== "template") throw new BoxError("missing", 404);
            return {
              ...box,
              exec: {
                command: async (command) => {
                  templateReads.push(command);
                  return { stdout: "", exitCode: 0 };
                },
              },
            };
          },
          create: async (config) => {
            assert.isUndefined(snapshotId);
            created = config;
            return box;
          },
          restore: async (id, config) => {
            restored = id;
            created = config;
            return box;
          },
          list: async () => [],
          checkModelKey: async () => 200,
        }),
        Effect.provide(
          Logger.layer(
            [
              Logger.make(({ logLevel, message }) => {
                if (logLevel === "Warn") warnings.push(message);
              }),
            ],
            { mergeWithExisting: false },
          ),
        ),
      );
      assert.deepEqual(created?.networkPolicy, { mode: "allow-all" });
      assert.equal(restored, snapshotId);
      assert.isUndefined(created?.agent);
      assert.isUndefined(created?.git);
      assert.equal(githubUser.mock.calls[0]?.[0], "https://api.github.com/user");
      if (profileStatus === 200) {
        assert.include(commands.join("\n"), "123+fixture-login@users.noreply.github.com");
        assert.deepEqual(warnings, []);
      } else {
        assert.notMatch(commands.join("\n"), /user\.(name|email)/u);
        assert.deepEqual(warnings, [
          ["Could not look up the GitHub profile for Box Git; skipping commit identity."],
        ]);
      }
      assert.include(commands.join("\n"), "credential.https://github.com.helper");
      assert.notInclude(commands.join("\n"), "fixture-github-token");
      assert.notInclude(JSON.stringify(created), "fixture-github-token");
      assert.notInclude(JSON.stringify([...files]), "fixture-github-token");
      for (const [pkg, credential] of [
        ["command-code", credentials.commandCode],
        ["@anthropic-ai/claude-code", credentials.claudeCode],
        ["@openai/codex", credentials.codex],
      ] as const) {
        assert.include(commands.join("\n"), `npm i -g --prefix /home/boxuser/.local ${pkg}@`);
        assert.notInclude(commands.join("\n"), credential);
        assert.notInclude(JSON.stringify(created), credential);
      }
      assert.equal(
        volatile.get("/dev/shm/t3stash-auth/command-home/.commandcode/auth.json"),
        credentials.commandCode,
      );
      assert.equal(volatile.get("/dev/shm/t3stash-auth/claudeCode-token"), credentials.claudeCode);
      assert.include(
        volatile.get("/dev/shm/t3stash-auth/codex/auth.json") ?? "",
        credentials.codex,
      );
      assert.deepEqual(templateReads, []);
    }),
);

it.effect("reports a refused Box creation for a missing stored model key", () =>
  Effect.gen(function* () {
    const error = yield* ensureBox(
      {
        apiKey: "key",
        templateBoxName: "template",
        size: "small",
        harness: "claudeCode",
        model: "anthropic/claude-opus-5",
        agentApiKey: "",
      },
      "thread-box",
    ).pipe(
      Effect.flip,
      Effect.provideService(BoxApi, {
        get: async () => {
          throw new BoxError("missing", 404);
        },
        create: async () => {
          throw new BoxError(
            "stored agent API key is not configured for the selected agent/model",
            400,
          );
        },
        list: async () => [],
        checkModelKey: async () => 200,
      }),
    );
    assert.isTrue(error.missingStoredKey);
  }),
);
