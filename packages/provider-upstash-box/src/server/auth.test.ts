import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import { EphemeralBox } from "@upstash/box";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { vi } from "vite-plus/test";

import { makeBoxHarnessAuth } from "./auth.ts";

vi.mock("@t3tools/provider-core/server/providerAuthFlow", () => ({ make: vi.fn() }));

it.effect.each(["success", "empty", "read-failure", "storage-failure"] as const)(
  "keeps interactive sign-in credentials volatile: %s",
  (scenario) =>
    Effect.gen(function* () {
      const flow: { value?: Parameters<typeof ProviderAuthFlow.make>[0] } = {};
      using _flow = vi.spyOn(ProviderAuthFlow, "make").mockImplementation((options) => {
        flow.value = options;
        return Effect.die("captured");
      });
      const commands: string[] = [];
      let deleted = false;
      let sessionHome: ReadonlyArray<string> = [];
      const credential = '{"token":"login-fixture"}';
      const saved: unknown[] = [];
      using _box = vi.spyOn(EphemeralBox, "create").mockResolvedValue({
        delete: async () => {
          deleted = true;
        },
        exec: {
          command: async (command: string) => {
            commands.push(command);
            return {
              stdout: command.startsWith("head ") && scenario !== "empty" ? credential : "",
              exitCode:
                (scenario === "read-failure" && command.startsWith("head ")) ||
                (scenario === "storage-failure" && command.startsWith("test "))
                  ? 1
                  : 0,
            };
          },
          session: async (options: { env: ReadonlyArray<string> }) => {
            sessionHome = options.env;
            return { wait: async () => 0, close: () => undefined };
          },
        },
      } as unknown as EphemeralBox);
      yield* makeBoxHarnessAuth(
        ProviderInstanceId.make("box"),
        "codex",
        Effect.succeed({ apiKey: "fixture", size: "small", templateBoxName: "" }),
        (patch) =>
          Effect.sync(() => {
            saved.push(patch);
            return DEFAULT_SERVER_SETTINGS;
          }),
      ).pipe(Effect.exit);
      if (!flow.value) throw new Error("Missing sign-in flow");
      const auth = flow.value
        .authenticate("box-terminal", {
          flowId: "flow",
          expiresAt: 1,
          setProgress: () => Effect.void,
          setInteraction: () => Effect.void,
          verifying: Effect.void,
        })
        .pipe(Effect.scoped);
      if (scenario === "success") {
        yield* auth;
        assert.deepEqual(saved, [{ upstashBox: { codexAuth: credential } }]);
      } else {
        const error = yield* auth.pipe(Effect.flip);
        assert.equal(error.operation, "start");
        assert.notInclude(JSON.stringify(error), credential);
        assert.deepEqual(saved, []);
      }
      assert.isTrue(deleted);
      assert.notInclude(commands.join("\n"), credential);
      if (scenario !== "storage-failure") {
        assert.include(sessionHome, "HOME=/dev/shm/t3stash-login");
        assert.include(
          commands.join("\n"),
          "head -c 16384 /dev/shm/t3stash-login/.codex/auth.json",
        );
      }
    }).pipe(Effect.provide(Layer.mock(SecureRandom.SecureRandom)({}))),
);
