import { assert, it } from "@effect/vitest";
import { BoxError, type BoxConfig } from "@upstash/box";
import * as Effect from "effect/Effect";

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
          { apiKey, templateBoxName: "template", size: "small", model: "" },
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
        };
        const bootstrap = ensureBox(
          { apiKey: "key", templateBoxName: "template", size: "small", model: "" },
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
