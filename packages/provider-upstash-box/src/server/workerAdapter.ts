import {
  ServerProviderModel,
  type ChatAttachment,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { BOX_HARNESS_DRIVER_KINDS, boxNameForThread, type WorkerBoxHarness } from "../harnesses.ts";
import type { BoxEnvironmentConfig } from "./adapter.ts";
import {
  BOX_ATTACHMENTS_PATH,
  BOX_HOME,
  BOX_REPOSITORY_PATH,
  BoxApi,
  BoxRuntimeError,
  ensureBoxWorktree,
  quoteShell,
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
const isProtocolError = Schema.is(Adapter.ProviderAdapterProtocolError);

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
  resolveAttachmentPath?: (attachment: ChatAttachment) => string | null,
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
      const boxCwd = yield* Effect.tryPromise({
        try: async () => {
          await requireCommand(box, `mkdir -p ${BOX_REPOSITORY_PATH}`);
          // A delegated session runs in its parent's Box: give it its own
          // worktree at the delegation's base commit, like the legacy adapter.
          return policy.repositoryUrl !== undefined && policy.boxOwnerThreadId !== undefined
            ? await ensureBoxWorktree(box, input.threadId, policy.boxBaseCommit)
            : BOX_REPOSITORY_PATH;
        },
        catch: () => failure("Could not open the Box workspace."),
      });
      const safeInput = {
        ...input,
        promptSuggestions: undefined,
        instanceId,
        config,
        runtimePolicy: { ...policy, cwd: boxCwd },
      };
      const launch = yield* Effect.try({
        try: () => encodeJson(sessionPayload("openSession", safeInput, "encode")),
        catch: () => failure("Could not encode the provider session."),
      });
      const worker = yield* openBoxProviderProcess(
        box,
        {
          argv: ["node", BOX_PROVIDER_WORKER_PATH, harness],
          cwd: boxCwd,
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
      const stageAttachments = (input: unknown) =>
        Effect.tryPromise({
          try: async () => {
            const message =
              typeof input === "object" && input !== null && "message" in input
                ? (input as { message?: { attachments?: ReadonlyArray<ChatAttachment> } }).message
                : undefined;
            if (message?.attachments === undefined || message.attachments.length === 0)
              return input;
            const upload = box.files.upload;
            if (upload === undefined || resolveAttachmentPath === undefined)
              throw new Error("Could not access the saved attachments for this Box turn.");
            const directory = `${BOX_ATTACHMENTS_PATH}/worker`;
            const uploads = message.attachments.map((attachment) => {
              const path = resolveAttachmentPath(attachment);
              if (path === null)
                throw new Error("Could not access the saved attachments for this Box turn.");
              const filename = attachment.name.replace(/[^a-zA-Z0-9._ -]/gu, "_").slice(-120);
              return { path, destination: `${directory}/${attachment.id}-${filename}` };
            });
            await requireCommand(box, `umask 077; mkdir -p -- ${quoteShell(directory)}`);
            for (const entry of uploads) {
              await upload([entry]);
            }
            return input;
          },
          catch: (error) =>
            isProtocolError(error)
              ? error
              : failure(
                  "Could not copy an attachment into this Box. Send the message again to retry.",
                ),
        });
      const call =
        <K extends keyof Adapter.ProviderAdapterV2SessionRuntime>(method: K) =>
        (
          input: Parameters<
            Extract<Adapter.ProviderAdapterV2SessionRuntime[K], (input: never) => unknown>
          >[0],
        ) =>
          stageAttachments(input).pipe(
            Effect.flatMap((staged) =>
              Effect.try({
                try: () => sessionPayload(method, boxWorkspace(staged, boxCwd), "encode"),
                catch: () => failure(`Could not encode ${method} for the Box worker.`),
              }),
            ),
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
                try: () =>
                  stampOwner(sessionResult(method, value, "decode"), policy.boxOwnerThreadId),
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

/** Replies that carry a provider thread record the shared Box owner on it, like the legacy adapter. */
function stampOwner(value: unknown, boxOwnerThreadId: ThreadId | undefined) {
  if (boxOwnerThreadId === undefined || typeof value !== "object" || value === null) return value;
  const thread = (value as { providerThread?: unknown }).providerThread;
  if (typeof thread !== "object" || thread === null) return value;
  const metadata = (thread as { nativeMetadata?: Record<string, unknown> | null }).nativeMetadata;
  return {
    ...value,
    providerThread: {
      ...thread,
      nativeMetadata: { ...metadata, boxOwnerThreadId },
    },
  };
}

function boxWorkspace(input: unknown, cwd: string) {
  if (
    typeof input !== "object" ||
    input === null ||
    !("runtimePolicy" in input) ||
    typeof input.runtimePolicy !== "object" ||
    input.runtimePolicy === null
  )
    return input;
  return { ...input, runtimePolicy: { ...input.runtimePolicy, cwd } };
}
