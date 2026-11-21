import { assert, it } from "@effect/vitest";
import { Agent, BoxApiKey, BoxError, type BoxConfig } from "@upstash/box";
import * as Effect from "effect/Effect";

import { BoxApi, type BoxHandle } from "./BoxApi.ts";
import { ensureBox } from "./bootstrap.ts";
import { commandCodeHarness } from "./harness.ts";

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
          assert.equal(writes.filter((path) => path.endsWith(".git-credentials")).length, 1);
          assert.include(commands, "chmod 600 /home/boxuser/.git-credentials");
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
    // A Box without a repository still gets the template's Git login for later clones.
    assert.include(commands, "test ! -f ~/.git-credentials || cat ~/.git-credentials");
    assert.equal(clones, 1);
  }),
);
