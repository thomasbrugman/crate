// @effect-diagnostics nodeBuiltinImport:off -- The worker's stdio is the Box session wire.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ProviderSetupError,
  ServerProviderModel,
} from "@t3tools/contracts";
import {
  encodeFrame,
  serveProviderSession,
  sessionPayload,
} from "@t3tools/provider-upstash-box/server";
import { CursorDriver } from "@t3tools/provider-cursor/server";
import * as CursorRunner from "@t3tools/provider-cursor/server/CursorAgentSdk";
import * as CursorSdk from "@t3tools/provider-cursor/server/CursorSdk";
import { OpenCodeDriver } from "@t3tools/provider-opencode/server";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerLedger from "@t3tools/provider-opencode/server/OpenCodeServerLedger";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import type { ProviderAdapterV2OpenSessionInput } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";

import {
  AntigravityInstallation,
  AntigravityInstallationError,
  makeAntigravityInstallation,
} from "./AntigravityInstallation.ts";
import { AntigravityDriver } from "./Drivers/AntigravityDriver.ts";
import * as ModelManifest from "./ModelManifest.ts";
import { isAntigravitySignInRequiredError } from "./antigravityAuthSupport.ts";

const stateDir = "/home/boxuser/.local/share/crate-provider-worker";
const credentialsDir = "/dev/shm/crate-auth";
const profileStateDir = `${credentialsDir}/worker-state`;
const harnessSchema = Schema.Literals(["opencode", "cursor", "antigravity"]);
type Harness = typeof harnessSchema.Type;
const parseHarness = Schema.decodeUnknownSync(harnessSchema);
const encodeModels = Schema.encodeSync(Schema.fromJsonString(Schema.Array(ServerProviderModel)));
const drivers = { opencode: OpenCodeDriver, cursor: CursorDriver, antigravity: AntigravityDriver };
const decodeSettings = {
  opencode: Schema.decodeSync(OpenCodeDriver.configSchema),
  cursor: Schema.decodeSync(CursorDriver.configSchema),
  antigravity: Schema.decodeSync(AntigravityDriver.configSchema),
};

const toolLayer = Layer.mergeAll(
  CursorRunner.layer.pipe(Layer.provideMerge(CursorSdk.layer)),
  OpenCodeRuntime.layer.pipe(Layer.provide(OpenCodeServerLedger.layer({ stateDir }))),
  Layer.effect(AntigravityInstallation, makeAntigravityInstallation({ baseDir: stateDir })),
  McpProviderSessions.layer,
  ProviderContinuationRequests.layer,
  IdAllocator.layer,
  ProviderLatestVersions.layer,
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      ModelManifest.layerTest,
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeCrypto.layer, NodeServices.layer, FetchHttpClient.layer)),
);

function hostLayer(cwd: string) {
  const settings = Effect.succeed(DEFAULT_SERVER_SETTINGS);
  return Layer.succeed(
    ProviderHost.ProviderHost,
    ProviderHost.ProviderHost.of({
      paths: {
        cwd,
        baseDir: stateDir,
        stateDir: profileStateDir,
        providerStatusCacheDir: NodePath.join(stateDir, "status"),
        attachmentsDir: NodePath.join(stateDir, "attachments"),
      },
      settings: {
        get: settings,
        withSnapshot: (use) => Effect.flatMap(settings, use),
        changes: Stream.never,
        subscribe: Effect.succeed(Stream.never),
      },
      compatibility: Effect.fn("BoxProviderWorker.compatibility")((driver, version) =>
        Effect.succeed(
          ModelManifest.providerCompatibility(
            ModelManifest.BUNDLED_MODEL_MANIFEST,
            driver,
            version,
          ),
        ),
      ),
      shouldRunBackgroundWork: Effect.fn("BoxProviderWorker.shouldRunBackgroundWork")(() =>
        Effect.succeed(false),
      ),
      resolveAttachmentPath: () => null,
      credentials: Effect.fn("BoxProviderWorker.credentials")((namespace, key) =>
        Effect.succeed({
          binding: { owner: "t3", key: `${namespace}:${key}` },
          get: Effect.succeedNone,
          set: () => Effect.void,
          remove: Effect.void,
        }),
      ),
    }),
  );
}

async function readCredential(harness: Harness) {
  try {
    return (
      await NodeFSP.readFile(NodePath.join(credentialsDir, harness, "credential"), "utf8")
    ).trim();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

const isProviderSetupError = Schema.is(ProviderSetupError);

function authenticationRequired(harness: Harness, error: unknown): boolean {
  const seen = new Set<unknown>();
  let cause = error;
  while (typeof cause === "object" && cause !== null && !seen.has(cause)) {
    seen.add(cause);
    if ("requiresSignIn" in cause && cause.requiresSignIn === true) return true;
    if (harness === "antigravity" && isAntigravitySignInRequiredError(cause)) return true;
    if (
      harness === "cursor" &&
      ((isProviderSetupError(cause) &&
        cause.operation === "credentials" &&
        cause.detail === "Sign in with Cursor or add CURSOR_API_KEY in provider settings.") ||
        ("name" in cause && cause.name === "AuthenticationError") ||
        ("message" in cause &&
          typeof cause.message === "string" &&
          cause.message.startsWith("API key is required for cloud operations.")))
    )
      return true;
    cause = "cause" in cause ? cause.cause : undefined;
  }
  return false;
}

const ensureAntigravity = Effect.fn("BoxProviderWorker.ensureAntigravity")(function* () {
  const installation = yield* AntigravityInstallation;
  const resolved = yield* installation.resolve().pipe(Effect.option);
  if (Option.isSome(resolved)) return;
  const operation = yield* installation.start;
  const outcome = yield* installation.changes.pipe(
    Stream.filter(
      (value) =>
        value.operationId === operation.operationId &&
        (value.phase === "succeeded" || value.phase === "failed" || value.phase === "cancelled"),
    ),
    Stream.runHead,
  );
  if (Option.isNone(outcome) || outcome.value.phase !== "succeeded") {
    return yield* new AntigravityInstallationError({
      operation: "install",
      detail: "The Antigravity installation in the Box did not complete.",
    });
  }
});

export async function runBoxProviderWorker() {
  const harness = parseHarness(process.argv[2]);
  const cwd = process.cwd();
  const credential = await readCredential(harness);
  if (harness === "cursor" && credential) process.env.CURSOR_API_KEY = credential;
  if (harness === "opencode") {
    const dataDir = NodePath.join(credentialsDir, "opencode", "data");
    const data = NodePath.join(dataDir, "opencode");
    const saved = NodePath.join(stateDir, "opencode");
    await NodeFSP.mkdir(data, { mode: 0o700, recursive: true });
    await NodeFSP.mkdir(saved, { mode: 0o700, recursive: true });
    for (const directory of ["storage", "snapshot"]) {
      const target = NodePath.join(saved, directory);
      await NodeFSP.mkdir(target, { mode: 0o700, recursive: true });
      try {
        await NodeFSP.symlink(target, NodePath.join(data, directory));
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
    }
    if (credential)
      await NodeFSP.writeFile(NodePath.join(data, "auth.json"), credential, { mode: 0o600 });
    else await NodeFSP.rm(NodePath.join(data, "auth.json"), { force: true });
    process.env.XDG_DATA_HOME = dataDir;
    process.env.OPENCODE_DB = NodePath.join(saved, "opencode.db");
  }
  const driver = drivers[harness];
  const mode = process.argv[3];
  const layer = toolLayer.pipe(Layer.provideMerge(Layer.merge(hostLayer(cwd), Logger.layer([]))));
  if (mode === "catalog") {
    const config = decodeSettings[harness]({ enabled: true });
    const models = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* driver.create({
          instanceId: ProviderInstanceId.make(harness),
          enabled: true,
          displayName: undefined,
          environment: [],
          config: config as never,
        });
        return (yield* provider.snapshot.refresh).models;
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
    process.stdout.write(encodeModels(models) + "\n");
    return;
  }
  const launch = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = launch[Symbol.asyncIterator]();
  try {
    const first = await lines.next();
    if (first.done) return;
    const input = sessionPayload(
      "openSession",
      JSON.parse(first.value),
      "decode",
    ) as ProviderAdapterV2OpenSessionInput & {
      readonly instanceId: string;
      readonly config?: unknown;
    };
    const config = decodeSettings[harness]({
      ...(typeof input.config === "object" && input.config !== null ? input.config : {}),
      ...(harness === "antigravity" && credential
        ? { authMethod: "gemini-api-key", apiKey: credential }
        : {}),
      enabled: true,
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        if (harness === "antigravity") yield* ensureAntigravity();
        const provider = yield* driver.create({
          instanceId: ProviderInstanceId.make(input.instanceId),
          enabled: true,
          displayName: undefined,
          environment: [],
          config: config as never,
        });
        const runtime = yield* provider.orchestrationAdapter.openSession({
          ...input,
          runtimePolicy: { ...input.runtimePolicy, cwd },
        });
        const stream = Stream.fromAsyncIterable(
          { [Symbol.asyncIterator]: () => lines },
          () => undefined,
        ).pipe(Stream.orDie);
        yield* serveProviderSession(
          runtime,
          stream,
          (line) => process.stdout.write(line),
          (error) => authenticationRequired(harness, error),
        );
      }).pipe(Effect.provide(layer), Effect.scoped, Effect.result),
    );
    if (result._tag === "Failure") {
      process.stdout.write(
        encodeFrame({
          type: "startup_failure",
          reason: authenticationRequired(harness, result.failure) ? "authentication" : "launch",
        }) + "\n",
      );
      process.exitCode = 1;
    }
  } finally {
    launch.close();
  }
}
