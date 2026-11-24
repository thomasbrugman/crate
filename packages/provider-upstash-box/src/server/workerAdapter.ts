import { ServerProviderModel, type ProviderInstanceId } from "@t3tools/contracts";
import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { BOX_HARNESS_DRIVER_KINDS, boxNameForThread, type WorkerBoxHarness } from "../harnesses.ts";
import type { BoxEnvironmentConfig } from "./adapter.ts";
import {
  BOX_HOME,
  BOX_REPOSITORY_PATH,
  BoxApi,
  BoxRuntimeError,
  requireCommand,
} from "./BoxApi.ts";
import { BOX_PROVIDER_WORKER_PATH, ensureBox, installConnectedHarnesses } from "./bootstrap.ts";
import { capabilities } from "./capabilities.ts";
import { sessionPayload, sessionResult } from "./providerSessionPayload.ts";
import { openBoxProviderProcess } from "./providerSessionProcess.ts";

const decodeModels = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(ServerProviderModel)),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const readBoxWorkerModels = Effect.fn("UpstashBox.readWorkerModels")(function* (
  harness: Exclude<WorkerBoxHarness, "antigravity">,
  apiKey: string,
  credential: string,
  workerArtifact: () => Promise<string>,
) {
  const api = yield* BoxApi;
  const failure = () => new BoxRuntimeError({ operation: "readWorkerModels" });
  const box = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        api.create({
          apiKey,
          runtime: "node",
          size: "small",
          keepAlive: false,
          labels: ["crate-catalog"],
        }),
      catch: failure,
    }),
    (box) => Effect.tryPromise({ try: () => box.delete(), catch: failure }).pipe(Effect.ignore),
  );
  return yield* Effect.tryPromise({
    try: async () => {
      await installConnectedHarnesses(
        box,
        {
          apiKey,
          templateBoxName: "",
          size: "small",
          harness,
          model: "",
          agentApiKey: "",
          credentials: { [harness]: credential },
          workerArtifact,
        },
        () => {},
      );
      const models = await box.exec.command(
        `PATH=${BOX_HOME}/.local/bin:$PATH node ${BOX_PROVIDER_WORKER_PATH} ${harness} catalog`,
      );
      if (models.exitCode !== 0) throw failure();
      return decodeModels(models.stdout.trim());
    },
    catch: failure,
  });
}, Effect.scoped);

export const makeBoxWorkerAdapter = Effect.fn("UpstashBox.makeWorkerAdapter")(function* (
  instanceId: ProviderInstanceId,
  harness: WorkerBoxHarness,
  environment: Effect.Effect<BoxEnvironmentConfig>,
  config: object,
  workerArtifact: () => Promise<string>,
) {
  const api = yield* BoxApi;
  const driver = BOX_HARNESS_DRIVER_KINDS[harness];
  const failure = (detail: string) => new Adapter.ProviderAdapterProtocolError({ driver, detail });
  return Adapter.ProviderAdapterV2.of({
    instanceId,
    driver,
    getCapabilities: Effect.fn("UpstashBox.workerCapabilities")(() => Effect.succeed(capabilities)),
    planSelectionTransition: Effect.fn("UpstashBox.workerSelectionTransition")(() =>
      Effect.succeed({ type: "apply_on_next_turn" }),
    ),
    openSession: Effect.fn("UpstashBox.openWorkerSession")(function* (input) {
      const settings = yield* environment;
      const policy = input.runtimePolicy;
      const name = boxNameForThread(policy.boxOwnerThreadId ?? input.threadId);
      const box = yield* ensureBox(
        {
          ...settings,
          credentials: settings.credentials ?? {},
          size: policy.boxSize ?? settings.size,
          harness,
          model: input.modelSelection.model,
          agentApiKey: "",
          workerArtifact,
          ...(policy.boxSnapshotId ? { snapshotId: policy.boxSnapshotId } : {}),
        },
        name,
        policy.repositoryUrl,
      ).pipe(
        Effect.provideService(BoxApi, api),
        Effect.mapError(() => failure("Could not prepare the provider's Upstash Box.")),
      );
      yield* Effect.tryPromise({
        try: () => requireCommand(box, `mkdir -p ${BOX_REPOSITORY_PATH}`),
        catch: () => failure("Could not open the Box workspace."),
      });
      const safeInput = {
        ...input,
        promptSuggestions: undefined,
        instanceId,
        config,
        runtimePolicy: { ...policy, cwd: BOX_REPOSITORY_PATH },
      };
      const launch = yield* Effect.try({
        try: () => encodeJson(sessionPayload("openSession", safeInput, "encode")),
        catch: () => failure("Could not encode the provider session."),
      });
      const worker = yield* openBoxProviderProcess(
        box,
        {
          argv: ["node", BOX_PROVIDER_WORKER_PATH, harness],
          cwd: BOX_REPOSITORY_PATH,
          env: [`PATH=${BOX_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin`],
        },
        launch,
      ).pipe(
        Effect.mapError((error) =>
          failure(
            error.reason === "authentication"
              ? "Connect this harness in Settings → Providers."
              : "The provider worker did not open a session in the Box.",
          ),
        ),
      );
      if (!worker.providerSession)
        return yield* failure("The worker did not return a provider session.");
      const has = (method: string) => worker.methods.has(method);
      const call =
        <K extends keyof Adapter.ProviderAdapterV2SessionRuntime>(method: K) =>
        (
          input: Parameters<
            Extract<Adapter.ProviderAdapterV2SessionRuntime[K], (input: never) => unknown>
          >[0],
        ) =>
          Effect.try({
            try: () => sessionPayload(method, boxWorkspace(input), "encode"),
            catch: () => failure(`Could not encode ${method} for the Box worker.`),
          }).pipe(
            Effect.flatMap((payload) =>
              worker
                .call(method, payload)
                .pipe(
                  Effect.mapError((error) =>
                    failure(
                      error.reason === "authentication"
                        ? "Connect this harness in Settings → Providers."
                        : `${method} failed in the Box worker.`,
                    ),
                  ),
                ),
            ),
            Effect.flatMap((value) =>
              Effect.try({
                try: () => sessionResult(method, value, "decode"),
                catch: () => failure(`Invalid ${method} reply from the Box worker.`),
              }),
            ),
          ) as ReturnType<
            Extract<Adapter.ProviderAdapterV2SessionRuntime[K], (input: never) => unknown>
          >;
      return {
        instanceId,
        driver,
        providerSessionId: input.providerSessionId,
        providerSession: worker.providerSession,
        revalidateLoadedThreads: true,
        events: worker.events.pipe(
          Stream.mapError(() => failure("The Box provider worker closed.")),
        ),
        ensureThread: call("ensureThread"),
        resumeThread: call("resumeThread"),
        startTurn: call("startTurn"),
        steerTurn: call("steerTurn"),
        interruptTurn: call("interruptTurn"),
        respondToRuntimeRequest: call("respondToRuntimeRequest"),
        readThreadSnapshot: call("readThreadSnapshot"),
        rollbackThread: call("rollbackThread"),
        forkThread: call("forkThread"),
        ...(has("injectHistory") ? { injectHistory: call("injectHistory") } : {}),
        ...(has("resumeTurn") ? { resumeTurn: call("resumeTurn") } : {}),
        ...(has("compactThread") ? { compactThread: call("compactThread") } : {}),
        ...(has("applyModelSelection") ? { applyModelSelection: call("applyModelSelection") } : {}),
        ...(has("applyThreadTitle") ? { applyThreadTitle: call("applyThreadTitle") } : {}),
        ...(has("stopTask") ? { stopTask: call("stopTask") } : {}),
        ...(has("awaitBackgroundTasks")
          ? { awaitBackgroundTasks: call("awaitBackgroundTasks") }
          : {}),
        ...(has("stopSubagent") ? { stopSubagent: call("stopSubagent") } : {}),
        ...(has("unloadThread") ? { unloadThread: call("unloadThread") } : {}),
        ...(has("uploadFeedback") ? { uploadFeedback: call("uploadFeedback") } : {}),
      } satisfies Adapter.ProviderAdapterV2SessionRuntime;
    }),
  });
});

function boxWorkspace(input: unknown) {
  if (
    typeof input !== "object" ||
    input === null ||
    !("runtimePolicy" in input) ||
    typeof input.runtimePolicy !== "object" ||
    input.runtimePolicy === null
  )
    return input;
  return { ...input, runtimePolicy: { ...input.runtimePolicy, cwd: BOX_REPOSITORY_PATH } };
}
