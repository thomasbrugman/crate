import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, SecretProviderId } from "@t3tools/contracts";
import { BoxApi } from "@t3tools/provider-upstash-box/server";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as BoxSnapshots from "./BoxSnapshots.ts";

it.effect.each([
  { source: "saved" },
  { source: "environment" },
  { source: "secret" },
  { source: "missing", reason: "not-configured" },
  { source: "saved", failure: "request", reason: "unavailable" },
  { source: "saved", failure: "response", reason: "unavailable" },
] as const)("lists account snapshots with safe credentials and failures: %j", (scenario) =>
  Effect.gen(function* () {
    const key = "test-box-key";
    const snapshots = yield* BoxSnapshots.BoxSnapshots;
    const result = yield* snapshots.list.pipe(Effect.result);
    if ("reason" in scenario) {
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.reason, scenario.reason);
        assert.notInclude(JSON.stringify(result.failure), key);
        assert.notInclude(JSON.stringify(result.failure), "authorization");
      }
    } else {
      assert.equal(result._tag, "Success");
      if (result._tag === "Success")
        assert.deepEqual(result.success.snapshots, [
          { id: "new", name: "New workspace", status: "creating", createdAt: 300 },
          { id: "ready", name: "Dependencies installed", status: "ready", createdAt: 200 },
          { id: "failed", name: "Failed workspace", status: "error", createdAt: 100 },
        ]);
    }
  }).pipe(
    Effect.provide([
      BoxSnapshots.layer.pipe(
        Layer.provide(
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              upstashBox: {
                ...DEFAULT_SERVER_SETTINGS.upstashBox,
                apiKey:
                  scenario.source === "saved"
                    ? "test-box-key"
                    : scenario.source === "secret"
                      ? { provider: SecretProviderId.make("test"), reference: "box-key" }
                      : "",
              },
            }),
          }),
        ),
        Layer.provide(
          Layer.mock(SecretResolver.SecretResolver)({
            read: () => Effect.succeed(["test-box-key"]),
          }),
        ),
        Layer.provide(
          Layer.mock(BoxApi.BoxApi)({
            get: async () => {
              throw new Error("Unexpected Box operation");
            },
            create: async () => {
              throw new Error("Unexpected Box operation");
            },
            list: async () => {
              throw new Error("Unexpected Box operation");
            },
            checkModelKey: async () => {
              throw new Error("Unexpected Box operation");
            },
            listSnapshots: async (apiKey) => {
              assert.equal(apiKey, "test-box-key");
              if ("failure" in scenario && scenario.failure === "request")
                throw { authorization: `Bearer ${apiKey}` };
              if ("failure" in scenario && scenario.failure === "response")
                return { snapshots: [{ authorization: apiKey }] };
              return {
                snapshots: [
                  { id: "failed", name: "Failed workspace", status: "error", created_at: 100 },
                  { id: "ready", name: "Dependencies installed", status: "ready", created_at: 200 },
                  { id: "deleted", name: "Deleted workspace", status: "deleted", created_at: 400 },
                  { id: "new", name: "New workspace", status: "creating", created_at: 300 },
                ],
              };
            },
          }),
        ),
      ),
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: scenario.source === "environment" ? { UPSTASH_BOX_API_KEY: "test-box-key" } : {},
        }),
      ),
    ]),
  ),
);
