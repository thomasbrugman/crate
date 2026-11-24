import {
  ProviderSetupError,
  type ChatAttachment,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderThreadId,
  type RunId,
} from "@t3tools/contracts";
import { providerMessageTextWithAttachmentPaths } from "@t3tools/provider-core/server/attachmentPrompt";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";
import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import { BoxError } from "@upstash/box";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { BOX_HARNESS_LABELS, type BoxHarness } from "../harnesses.ts";
import {
  BOX_ATTACHMENTS_PATH,
  BOX_HOME,
  BOX_REPOSITORY_PATH,
  BOX_WORKSPACE_PATH,
  BoxApi,
  BoxRuntimeError,
  ensureBoxWorktree,
  isMissingBox,
  quoteShell,
  requireCommand,
  type BoxHandle,
  type BoxStream,
} from "./BoxApi.ts";
import {
  BOX_HARNESS_PATH,
  BOX_MANAGED_HARNESS_PATH,
  ensureBox,
  installConnectedHarnesses,
  type BoxRuntimeConfig,
  type BoxSetupStep,
} from "./bootstrap.ts";
import { capabilities as baseCapabilities } from "./capabilities.ts";
import { harnessCredentialKind } from "./credentials.ts";
import { execHarness } from "./execHarness.ts";
import { forkWorkspace } from "./forkWorkspace.ts";
import { EXCLUDE_HARNESS_FILES_COMMAND, makeBoxGitSetup } from "./git.ts";
import { commandCodeHarness } from "./harness.ts";
import { cancelBoxRun } from "./stop.ts";
import { BoxTurnTranslation } from "./translation.ts";

/** Where a thread runs, read from the environment's settings each time a Box is reached. */
export type BoxEnvironmentConfig = Pick<
  BoxRuntimeConfig,
  "apiKey" | "templateBoxName" | "size" | "credentials" | "githubToken"
>;

/** Which agent runs inside the thread's Box. */
export interface BoxAgentConfig {
  readonly driver: ProviderDriverKind;
  readonly harness: BoxHarness;
  readonly agentApiKey: string;
}

interface ActiveTurn {
  box: BoxHandle;
  runMarker: string;
  stream?: BoxStream;
  translation: BoxTurnTranslation;
  interrupted: boolean;
}

const CHECKSUM_ATTACHMENTS = String.raw`
checksum_attachments() (
  cd -- "$1" || exit 1
  export LC_ALL=C
  for path in ./* ./.[!.]* ./..?*; do
    test -e "$path" || test -L "$path" || continue
    test "$path" != ./.checksums || continue
    test -f "$path" && test ! -L "$path" && sha256sum -- "$path" || exit 1
  done
)
`;

// Exits 0 only when the Box holds nothing a fresh clone would lose: no uncommitted or
// untracked or ignored files, stashes, commits missing from the remote, or files beside the repository.
// Every Box starts with the agent configuration directories below in its workspace, and
// unmodified staged attachments and untracked Command Code taste files are not work.
const SAVED_WORK_CHECK = String.raw`
${CHECKSUM_ATTACHMENTS}
cd /workspace/home || exit 1
home=$(pwd -P) || exit 1
clean_checkout() (
  cd -- "$1" &&
  test "$(git rev-parse --show-toplevel)" = "$1" &&
  test "$(git rev-parse --path-format=absolute --git-common-dir)" = "$home/repo/.git" &&
  status=$(git -c status.showUntrackedFiles=all status --porcelain --ignored) &&
  test -z "$(printf '%s\n' "$status" | grep -Ev '^(\?\?|!!) \.commandcode/taste/')" &&
  unpushed=$(git rev-list --count HEAD --branches --not --remotes) &&
  test "$unpushed" = 0
)
for path in ./* ./.[!.]* ./..?*; do
  test -e "$path" || test -L "$path" || continue
  case "$path" in
    ./repo|./.crate-worktrees|./.crate-attachments|./.box|./.box-internal|./.claude|./.codex|./.cursor|./.local) ;;
    *) exit 1 ;;
  esac
done
if test -e repo || test -L repo; then
  test ! -L repo && test -d repo/.git && clean_checkout "$home/repo" || exit 1
  stash=$(git -C repo stash list) && test -z "$stash" || exit 1
  checkpoints=$(git -C repo for-each-ref --count=1 refs/t3/orchestration-v2/checkpoints/) &&
    test -z "$checkpoints" || exit 1
fi
if test -e .crate-worktrees || test -L .crate-worktrees; then
  test ! -L .crate-worktrees && test -d .crate-worktrees || exit 1
  for path in "$home"/.crate-worktrees/* "$home"/.crate-worktrees/.[!.]* "$home"/.crate-worktrees/..?*; do
    test -e "$path" || test -L "$path" || continue
    test ! -L "$path" && test -f "$path/.git" && clean_checkout "$path" || exit 1
  done
fi
if test -e .crate-attachments || test -L .crate-attachments; then
  test ! -L .crate-attachments && test -d .crate-attachments || exit 1
  for path in .crate-attachments/* .crate-attachments/.[!.]* .crate-attachments/..?*; do
    test -e "$path" || test -L "$path" || continue
    test -d "$path" && test ! -L "$path" || exit 1
    test -s "$path/.checksums" && test -f "$path/.checksums" && test ! -L "$path/.checksums" || exit 1
    expected=$(cat -- "$path/.checksums") && actual=$(checksum_attachments "$path") &&
      test "$actual" = "$expected" || exit 1
  done
fi
`;

const SETUP_STEP_TEXT: Record<BoxSetupStep, string> = {
  connect: "Connecting to the Box",
  create: "Creating the Box",
  check: "Checking the Box setup",
  install: "Installing harnesses",
  credentials: "Preparing credentials",
  clone: "Cloning the repository",
  "snapshot-fallback": "Project snapshot unavailable; starting with a fresh Box",
};

const boxStoppedMessage = "This thread's Box stopped mid-turn. Send a message to start a new one.";

export const makeUpstashBoxAdapter = Effect.fn("UpstashBox.makeAdapter")(function* (
  instanceId: ProviderInstanceId,
  agent: BoxAgentConfig,
  environment: Effect.Effect<BoxEnvironmentConfig>,
  mcpSessions?: McpProviderSessions["Service"],
  resolveAttachmentPath?: (attachment: ChatAttachment) => string | null,
  /** Copies the Box's transcripts to the host for usage history; never fails. */
  mirrorTranscripts: (
    box: BoxHandle,
    options?: { readonly everyHarness?: boolean },
  ) => Effect.Effect<void> = () => Effect.void,
) {
  const { driver, harness } = agent;
  const capabilities = {
    ...baseCapabilities,
    threads: { ...baseCapabilities.threads, canRollbackThread: harness === "commandCode" },
    checkpointing: {
      ...baseCapabilities.checkpointing,
      appCanCheckpointFilesystem: harness === "commandCode",
      providerRollbackReturnsSnapshot: harness === "commandCode",
    },
    turns: {
      ...baseCapabilities.turns,
      supportsSteeringByInterruptRestart: harness === "commandCode",
    },
    tools: { ...baseCapabilities.tools, supportsMcpTools: mcpSessions !== undefined },
    subagents:
      harness === "claudeCode"
        ? {
            ...baseCapabilities.subagents,
            supportsSubagents: true,
            exposesSubagentThreadIds: true,
            emitsSubagentLifecycle: true,
          }
        : baseCapabilities.subagents,
  };
  const ids = yield* IdAllocator.IdAllocatorV2;
  const api = yield* BoxApi;
  const authenticationCause = (error: BoxRuntimeError, apiKey: string) => {
    const detail = !apiKey.trim()
      ? "Upstash Box API key is missing. Add it in Settings → Providers."
      : error.statusCode === 401 || error.statusCode === 403
        ? "Upstash Box rejected the API key. Check it in Settings → Providers."
        : undefined;
    return detail === undefined
      ? undefined
      : new ProviderSetupError({ instanceId, operation: "authenticate", detail });
  };
  const unsupported = (operation: string) =>
    Effect.fail(
      new Adapter.ProviderAdapterProtocolError({
        driver,
        detail: `${operation} is not supported by ${BOX_HARNESS_LABELS[harness]} in Upstash Box`,
      }),
    );
  const removeBox = (thread: OrchestrationV2ProviderThread, keepUnsavedWork: boolean) => {
    if (thread.nativeMetadata?.boxOwnerThreadId) return Effect.succeed(false);
    const nativeId =
      thread.nativeThreadRef?.nativeId ??
      (thread.appThreadId ? `t3-${Buffer.from(thread.appThreadId).toString("hex")}` : undefined);
    const failed = () =>
      new Adapter.ProviderAdapterProtocolError({
        driver,
        detail: "Could not delete the thread Box.",
      });
    return Effect.flatMap(environment, ({ apiKey }) =>
      Effect.gen(function* () {
        if (!nativeId) return true;
        const box = yield* Effect.tryPromise({
          try: async () => {
            try {
              const box = await api.get(nativeId, apiKey);
              if (keepUnsavedWork && (await box.exec.command(SAVED_WORK_CHECK)).exitCode !== 0)
                return "unsaved" as const;
              return box;
            } catch (error) {
              if (!isMissingBox(error)) throw error;
              return "missing" as const;
            }
          },
          catch: failed,
        });
        if (box === "unsaved") return false;
        if (box === "missing") return true;
        yield* mirrorTranscripts(box, { everyHarness: true });
        yield* Effect.tryPromise({
          try: async () => {
            try {
              await box.delete();
            } catch (error) {
              if (!isMissingBox(error)) throw error;
            }
          },
          catch: failed,
        });
        return true;
      }),
    );
  };
  return Adapter.ProviderAdapterV2.of({
    instanceId,
    driver,
    deleteThread: Effect.fn("UpstashBox.deleteThread")(function* (thread) {
      yield* removeBox(thread, false);
    }),
    deleteIdleThread: Effect.fn("UpstashBox.deleteIdleThread")((thread) => removeBox(thread, true)),
    getCapabilities: Effect.fn("UpstashBox.getCapabilities")(() => Effect.succeed(capabilities)),
    planSelectionTransition: Effect.fn("UpstashBox.planSelectionTransition")(() =>
      Effect.succeed({ type: "apply_on_next_turn" }),
    ),
    openSession: Effect.fn("UpstashBox.openSession")(function* (input) {
      const scope = yield* Effect.scope;
      const configureBoxGit = yield* makeBoxGitSetup;
      const events = yield* Queue.unbounded<Adapter.ProviderAdapterV2Event>();
      const boxes = new Map<string, BoxHandle>();
      const recreatedThreads = new Set<ProviderThreadId>();
      let active: ActiveTurn | undefined;
      let interruptedPrompt:
        | {
            readonly runId: RunId;
            readonly providerThreadId: ProviderThreadId;
            readonly text: string;
          }
        | undefined;
      const now = yield* DateTime.now;
      let providerSession: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver,
        providerInstanceId: instanceId,
        status: "ready" as const,
        cwd: BOX_WORKSPACE_PATH,
        model: input.modelSelection?.model ?? null,
        capabilities,
        extensionStatuses: [],
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const publish = (batch: ReadonlyArray<Adapter.ProviderAdapterV2Event>) =>
        Queue.offerAll(events, batch).pipe(Effect.asVoid);
      const setSessionStatus = Effect.fn("UpstashBox.setSessionStatus")(function* (
        status: OrchestrationV2ProviderSession["status"],
      ) {
        providerSession = {
          ...providerSession,
          status,
          extensionStatuses: [],
          updatedAt: yield* DateTime.now,
        };
        yield* publish([{ type: "provider_session.updated", driver, providerSession }]);
      });
      // Called from inside the bootstrap promise, so it publishes synchronously. Clients
      // translate by key; the text is the English fallback.
      const showSetupStep = (step: BoxSetupStep) => {
        providerSession = {
          ...providerSession,
          extensionStatuses: [
            // Older clients read index 0 as the current setup step.
            { key: `upstash-box.setup.${step}`, text: SETUP_STEP_TEXT[step] },
            ...(providerSession.extensionStatuses ?? []),
          ],
          updatedAt: DateTime.nowUnsafe(),
        };
        Queue.offerUnsafe(events, { type: "provider_session.updated", driver, providerSession });
      };
      const saveThread = Effect.fn("UpstashBox.saveThread")(function* (
        thread: OrchestrationV2ProviderThread,
        box: BoxHandle,
      ) {
        boxes.set(box.id, box);
        yield* publish([{ type: "provider_thread.updated", driver, providerThread: thread }]);
        return thread;
      });
      const runtime: Adapter.ProviderAdapterV2SessionRuntime = {
        instanceId,
        driver,
        providerSessionId: input.providerSessionId,
        revalidateLoadedThreads: true,
        get providerSession() {
          return providerSession;
        },
        events: Stream.fromEffectRepeat(Queue.take(events)),
        ensureThread: Effect.fn("UpstashBox.ensureThread")(function* (request) {
          if (request.existingProviderThread?.nativeThreadRef?.nativeId)
            return yield* runtime.resumeThread({
              providerThread: request.existingProviderThread,
              runtimePolicy: request.runtimePolicy,
            });
          // Hex encoding is injective, shell-safe, and stable across server restarts.
          const name = `t3-${Buffer.from(request.runtimePolicy.boxOwnerThreadId ?? request.threadId).toString("hex")}`;
          const config: BoxRuntimeConfig = {
            ...(yield* environment),
            harness,
            model: request.modelSelection.model,
            agentApiKey: agent.agentApiKey,
          };
          yield* setSessionStatus("starting");
          const box = yield* ensureBox(
            {
              ...config,
              size: request.runtimePolicy.boxSize ?? config.size,
              ...(request.runtimePolicy.boxSnapshotId
                ? { snapshotId: request.runtimePolicy.boxSnapshotId }
                : {}),
            },
            name,
            request.runtimePolicy.repositoryUrl,
            showSetupStep,
          ).pipe(
            Effect.provideService(BoxApi, api),
            Effect.tapError(() => setSessionStatus("error")),
            Effect.mapError((error) =>
              error.missingStoredKey
                ? new Adapter.ProviderAdapterProtocolError({
                    driver,
                    detail: `Your Upstash account has no stored model key for ${BOX_HARNESS_LABELS[harness]}. Set a model API key in its provider settings`,
                  })
                : new Adapter.ProviderAdapterEnsureThreadError({
                    driver,
                    threadId: request.threadId,
                    cause: authenticationCause(error, config.apiKey),
                  }),
            ),
          );
          if (request.boxFork) {
            const { sourceBoxId, checkpointRef } = request.boxFork;
            yield* Effect.tryPromise({
              try: async () =>
                forkWorkspace(await api.get(sourceBoxId, config.apiKey), box, checkpointRef),
              catch: () =>
                new Adapter.ProviderAdapterProtocolError({
                  driver,
                  detail: "Could not copy the source checkpoint into the fork's Box.",
                }),
            }).pipe(Effect.tapError(() => setSessionStatus("error")));
          }
          yield* setSessionStatus("ready");
          const at = yield* DateTime.now;
          const thread: OrchestrationV2ProviderThread = {
            id:
              request.existingProviderThread?.id ??
              ids.derive.providerThread({
                driver,
                providerInstanceId: instanceId,
                nativeThreadId: request.threadId,
              }),
            driver,
            providerInstanceId: instanceId,
            providerSessionId: input.providerSessionId,
            appThreadId: request.threadId,
            ownerNodeId: null,
            nativeThreadRef: { driver, nativeId: box.id, strength: "strong" },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [],
            contextUsage: null,
            nativeMetadata: request.runtimePolicy.boxOwnerThreadId
              ? { boxOwnerThreadId: request.runtimePolicy.boxOwnerThreadId }
              : null,
            goal: null,
            createdAt: at,
            updatedAt: at,
          };
          return yield* saveThread(thread, box);
        }),
        resumeThread: Effect.fn("UpstashBox.resumeThread")(function* (request) {
          const previous = request.providerThread;
          const nativeId = previous.nativeThreadRef?.nativeId;
          if (!nativeId) return yield* unsupported("Resuming a thread without a Box identity");
          const runtimePolicy = request.runtimePolicy ?? input.runtimePolicy;
          const boxOwnerThreadId =
            previous.nativeMetadata?.boxOwnerThreadId ?? runtimePolicy.boxOwnerThreadId;
          const config: BoxRuntimeConfig = {
            ...(yield* environment),
            harness,
            model: request.modelSelection?.model ?? input.modelSelection.model,
            agentApiKey: agent.agentApiKey,
          };
          const box = yield* Effect.tryPromise({
            try: async () => {
              try {
                if (!config.apiKey.trim()) throw new BoxRuntimeError({ operation: "get" });
                const existing = await api.get(nativeId, config.apiKey);
                // Lookup by ID also returns deleted Box tombstones; status does not.
                await existing.getStatus();
                await configureBoxGit(existing, config.githubToken);
                await requireCommand(existing, EXCLUDE_HARNESS_FILES_COMMAND);
                if (config.credentials) {
                  await installConnectedHarnesses(existing, config, () => {});
                } else if (harness === "commandCode") {
                  await existing.files.write({
                    path: "/home/boxuser/.local/bin/crate-harness.mjs",
                    content: commandCodeHarness,
                  });
                }
                return existing;
              } catch (error) {
                if (!isMissingBox(error)) throw error;
                return null;
              }
            },
            catch: (error) =>
              new Adapter.ProviderAdapterResumeThreadError({
                driver,
                providerSessionId: input.providerSessionId,
                providerThreadId: previous.id,
                cause: authenticationCause(
                  new BoxRuntimeError({
                    operation: "get",
                    ...(error instanceof BoxError && error.statusCode !== undefined
                      ? { statusCode: error.statusCode }
                      : {}),
                  }),
                  config.apiKey,
                ),
              }),
          });
          if (!box) {
            const threadId = request.threadId ?? previous.appThreadId;
            if (!threadId)
              return yield* unsupported("Recreating a Box without an app thread identity");
            yield* setSessionStatus("starting");
            const replacement = yield* ensureBox(
              {
                ...config,
                size: runtimePolicy.boxSize ?? config.size,
                ...(runtimePolicy.boxSnapshotId ? { snapshotId: runtimePolicy.boxSnapshotId } : {}),
              },
              `t3-${Buffer.from(boxOwnerThreadId ?? threadId).toString("hex")}`,
              runtimePolicy.repositoryUrl,
              showSetupStep,
            ).pipe(
              Effect.provideService(BoxApi, api),
              Effect.tapError(() => setSessionStatus("error")),
              Effect.mapError(
                (error) =>
                  new Adapter.ProviderAdapterEnsureThreadError({
                    driver,
                    threadId,
                    cause: authenticationCause(error, config.apiKey),
                  }),
              ),
            );
            yield* setSessionStatus("ready");
            boxes.delete(nativeId);
            const recreated = yield* saveThread(
              {
                ...previous,
                providerSessionId: input.providerSessionId,
                nativeThreadRef: { driver, nativeId: replacement.id, strength: "strong" },
                nativeConversationHeadRef: null,
                pendingBackgroundTasks: [],
                contextUsage: null,
                nativeMetadata: boxOwnerThreadId ? { boxOwnerThreadId } : null,
                status: "idle",
                updatedAt: yield* DateTime.now,
              },
              replacement,
            );
            recreatedThreads.add(recreated.id);
            return recreated;
          }
          return yield* saveThread(
            {
              ...previous,
              providerSessionId: input.providerSessionId,
              status: "idle",
              updatedAt: yield* DateTime.now,
            },
            box,
          );
        }),
        startTurn: Effect.fn("UpstashBox.startTurn")(function* (request) {
          if (active)
            return yield* new Adapter.ProviderAdapterProtocolError({
              driver,
              detail: "A Box turn is already active",
              reason: "previous_turn_active",
            });
          if (request.resume) return yield* unsupported("Native turn resume");
          if (request.runtimePolicy.runtimeMode !== "full-access")
            return yield* unsupported("Restricted runtime policies");
          const providerThread = request.providerThread;
          const box = boxes.get(providerThread.nativeThreadRef?.nativeId ?? "");
          if (!box) return yield* new Adapter.ProviderAdapterSessionStoppedError({ driver });
          const config = yield* environment;
          const { credentials } = config;
          const credential = credentials?.[harness] || agent.agentApiKey;
          const credentialKind = harnessCredentialKind(harness, credential);
          if (credentials && !credentialKind)
            return yield* new Adapter.ProviderAdapterProtocolError({
              driver,
              detail: "Connect this harness in Settings → Providers.",
            });
          const mcp =
            credentials && box.exec.session && mcpSessions
              ? yield* mcpSessions.read(request.threadId)
              : undefined;
          const mcpSession = mcp?.providerInstanceId === instanceId ? mcp : undefined;
          const previousPrompt =
            interruptedPrompt?.runId === request.runId &&
            interruptedPrompt.providerThreadId === providerThread.id
              ? interruptedPrompt.text
              : undefined;
          interruptedPrompt = undefined;
          const attachmentDirectory = `${BOX_ATTACHMENTS_PATH}/${Buffer.from(request.attemptId).toString("hex")}`;
          const attachments: Array<{ path: string; destination: string }> = [];
          const attachmentDestinations = new Map<string, string>();
          const upload = box.files.upload;
          for (const [index, attachment] of request.message.attachments.entries()) {
            const path = resolveAttachmentPath?.(attachment);
            if (!path || !upload)
              return yield* new Adapter.ProviderAdapterProtocolError({
                driver,
                detail: "Could not access the saved attachments for this Box turn.",
              });
            const filename = attachment.name.replace(/[^a-zA-Z0-9._ -]/gu, "_").slice(-120);
            const destination = `${attachmentDirectory}/${index}-${filename}`;
            attachments.push({ path, destination });
            attachmentDestinations.set(attachment.id, destination);
          }
          const messageText = yield* providerMessageTextWithAttachmentPaths({
            text: request.message.text,
            attachments: request.message.attachments,
            resolveAttachmentPath: (attachment) =>
              attachmentDestinations.get(attachment.id) ?? null,
          });
          // Managed agents start in the Box workspace, so they are told where the clone is.
          const messageContext = [
            ...(previousPrompt === undefined ? [] : [previousPrompt]),
            ...(request.appContext ?? []).map(({ text }) => text),
            ...(!credentials && harness !== "commandCode" && request.runtimePolicy.repositoryUrl
              ? [`The repository is checked out at ${BOX_REPOSITORY_PATH}.`]
              : []),
            ...([...request.message.text.matchAll(SKILL_MENTION_PATTERN)].length > 0
              ? [
                  "When the user mentions an installed skill with $name, follow that skill’s instructions from this Box.",
                ]
              : []),
          ];
          // These harnesses recognize native commands only at the start of the prompt.
          const nativeSlash =
            harness !== "codex" && /^\/[a-zA-Z0-9_:.-]+(?:\s|$)/u.test(messageText);
          const prompt = (
            nativeSlash ? [messageText, ...messageContext] : [...messageContext, messageText]
          ).join("\n\n");
          const runMarker = `crate-run:${Buffer.from(request.attemptId).toString("hex")}\n`;
          const streamPrompt = harness === "commandCode" ? runMarker + prompt : prompt;
          const translation = new BoxTurnTranslation(
            { ...request, providerThread },
            ids.derive,
            yield* DateTime.now,
          );
          let failureMessage: string | undefined;
          const streamError = (error: unknown, fromAgentStream = false) => {
            if (isMissingBox(error)) failureMessage = boxStoppedMessage;
            else if (
              fromAgentStream &&
              error instanceof BoxError &&
              error.statusCode === undefined &&
              error.cause === undefined &&
              !/[{}]/u.test(error.message) &&
              Reflect.ownKeys(error).every(
                (key) =>
                  typeof key === "string" &&
                  ["message", "stack", "name", "statusCode", "cause"].includes(key),
              )
            )
              failureMessage = "The Box agent reported an error. Send a message to retry.";
            return new BoxRuntimeError({ operation: "stream" });
          };
          const turn: ActiveTurn = { box, runMarker, translation, interrupted: false };
          active = turn;
          yield* publish(translation.start(yield* DateTime.now));
          if (recreatedThreads.has(providerThread.id)) {
            const at = yield* DateTime.now;
            yield* publish([
              {
                type: "turn_item.updated",
                driver,
                turnItem: {
                  id: ids.derive.turnItemFromProviderItem({
                    driver,
                    nativeItemId: `${request.attemptId}:box-recreated`,
                  }),
                  threadId: request.threadId,
                  runId: request.runId,
                  nodeId: request.rootNodeId,
                  providerThreadId: providerThread.id,
                  providerTurnId: translation.providerTurnId,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 0,
                  status: "completed",
                  title: "A new Box was started",
                  type: "system_notice",
                  level: "warning",
                  message:
                    "This thread's Box was gone, so a new one was started. The agent doesn't have the earlier conversation, and uncommitted changes from the old Box are lost.",
                  startedAt: at,
                  completedAt: at,
                  updatedAt: at,
                },
              },
            ]);
            recreatedThreads.delete(providerThread.id);
          }
          const process = Effect.gen(function* () {
            // Box resumes the agent from the prior finish.sessionId.
            const stream = yield* Effect.tryPromise({
              try: async () => {
                let stream: BoxStream;
                const start = async () => {
                  if (upload && attachments.length > 0) {
                    try {
                      await requireCommand(
                        box,
                        `umask 077; mkdir -p -- ${quoteShell(attachmentDirectory)}`,
                      );
                      for (const { path, destination } of attachments) {
                        await upload([{ path, destination }]);
                      }
                      await requireCommand(
                        box,
                        `${CHECKSUM_ATTACHMENTS}\nchecksum_attachments ${quoteShell(attachmentDirectory)} > ${quoteShell(`${attachmentDirectory}/.checksums`)}`,
                      );
                    } catch (error) {
                      if (
                        isMissingBox(error) ||
                        (error instanceof BoxError && error.statusCode === 409)
                      )
                        throw error;
                      failureMessage =
                        "Could not copy an attachment into this Box. Send the message again to retry.";
                      throw new BoxRuntimeError({ operation: "attachments" });
                    }
                  }
                  if (!credentials) return box.agent.stream({ prompt: streamPrompt });
                  const cwd = request.runtimePolicy.repositoryUrl
                    ? providerThread.nativeMetadata?.boxOwnerThreadId
                      ? await ensureBoxWorktree(
                          box,
                          request.threadId,
                          request.appThread.lineage.boxBaseCommit,
                        )
                      : BOX_REPOSITORY_PATH
                    : BOX_WORKSPACE_PATH;
                  const model = request.modelSelection.model.replace(
                    /^(?:openai|anthropic)\//u,
                    "",
                  );
                  const session = providerThread.nativeConversationHeadRef?.nativeId ?? "";
                  const markedPrompt = runMarker + prompt;
                  const planMode = request.runtimePolicy.interactionMode === "plan";
                  const args =
                    harness === "commandCode"
                      ? [
                          BOX_HARNESS_PATH,
                          "-p",
                          markedPrompt,
                          "--explicit-session",
                          ...(model === "default" ? [] : ["--model", model]),
                          ...(session ? ["--session", session] : []),
                          ...(mcpSession === undefined ? [] : ["--t3-mcp-relay"]),
                          ...(planMode ? ["--plan"] : []),
                        ]
                      : [
                          BOX_MANAGED_HARNESS_PATH,
                          harness,
                          markedPrompt,
                          model,
                          session,
                          credentialKind ?? "",
                          ...(mcpSession === undefined ? [] : ["relay"]),
                          ...(planMode ? ["plan"] : []),
                        ];
                  return execHarness(
                    box,
                    `cd ${cwd} && PATH=${BOX_HOME}/.local/bin:$PATH BOXJOB_CC_CWD=${cwd} exec node ${args.map(quoteShell).join(" ")}`,
                    mcpSession,
                  );
                };
                try {
                  stream = await start();
                } catch (error) {
                  if (!(error instanceof BoxError) || error.statusCode !== 409) throw error;
                  // A cancelled run can leave the Box rejecting work until explicitly resumed.
                  await box.resume();
                  await configureBoxGit(box, config.githubToken);
                  stream = await start();
                }
                turn.stream = stream;
                return stream;
              },
              catch: (error) => streamError(error),
            }).pipe(Effect.uninterruptible);
            if (turn.interrupted) yield* cancelBoxRun(box, stream, runMarker);
            yield* Stream.fromAsyncIterable(stream, (error) => streamError(error, true)).pipe(
              Stream.runForEach((chunk) =>
                Effect.gen(function* () {
                  yield* publish(translation.accept(chunk, yield* DateTime.now));
                }),
              ),
            );
          });
          yield* process.pipe(
            Effect.onInterrupt(() =>
              turn.stream
                ? cancelBoxRun(box, turn.stream, runMarker).pipe(Effect.ignore)
                : Effect.void,
            ),
            Effect.isFailure,
            Effect.flatMap(
              Effect.fn("UpstashBox.finishTurn")(function* (failed) {
                if (
                  !turn.interrupted &&
                  (failed || !translation.hasFinished) &&
                  failureMessage !== boxStoppedMessage
                ) {
                  yield* Effect.promise(async () => {
                    try {
                      await box.getStatus();
                    } catch (error) {
                      if (isMissingBox(error)) failureMessage = boxStoppedMessage;
                    }
                  }).pipe(Effect.timeoutOption("3 seconds"));
                }
                if (translation.sessionId) {
                  const thread = providerThread;
                  yield* saveThread(
                    {
                      ...thread,
                      nativeConversationHeadRef: {
                        driver,
                        nativeId: translation.sessionId,
                        strength: "strong",
                      },
                      updatedAt: yield* DateTime.now,
                    },
                    box,
                  );
                }
                if (harness === "commandCode" && turn.interrupted && !translation.sessionId)
                  interruptedPrompt = {
                    runId: request.runId,
                    providerThreadId: providerThread.id,
                    text: prompt,
                  };
                active = undefined;
                yield* publish(
                  translation.complete(
                    yield* DateTime.now,
                    turn.interrupted,
                    failed,
                    failureMessage,
                  ),
                );
                yield* mirrorTranscripts(box).pipe(Effect.forkIn(scope));
              }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                if (active === turn) active = undefined;
              }),
            ),
            Effect.forkIn(scope),
          );
        }),
        interruptTurn: Effect.fn("UpstashBox.interruptTurn")(function* (request) {
          if (!active || active.translation.providerTurnId !== request.providerTurnId) return;
          active.interrupted = true;
          const { stream, box, runMarker } = active;
          if (stream)
            yield* cancelBoxRun(box, stream, runMarker).pipe(
              Effect.mapError(
                () =>
                  new Adapter.ProviderAdapterInterruptError({
                    driver,
                    providerThreadId: request.providerThread.id,
                    providerTurnId: request.providerTurnId,
                  }),
              ),
            );
        }),
        steerTurn: (request) =>
          Effect.fail(
            new Adapter.ProviderAdapterSteerRunUnsupportedError({
              driver,
              providerThreadId: request.providerThread.id,
            }),
          ),
        readThreadSnapshot: () => unsupported("Reading a conversation snapshot"),
        rollbackThread: Effect.fn("UpstashBox.rollbackThread")(function* (request) {
          if (harness !== "commandCode" || (yield* environment).credentials === undefined)
            return yield* unsupported("Rollback");
          if (active)
            return yield* new Adapter.ProviderAdapterProtocolError({
              driver,
              detail: "Cannot roll back an active Box turn.",
            });
          return {
            providerThread: {
              ...request.providerThread,
              nativeConversationHeadRef: null,
              contextUsage: null,
              lastRunOrdinal: request.target.appRunOrdinal || null,
              status: "idle",
              updatedAt: yield* DateTime.now,
            },
            providerTurns: [],
            messages: [],
            runtimeRequests: [],
          };
        }),
        forkThread: () => unsupported("Fork"),
        respondToRuntimeRequest: () => unsupported("Runtime requests"),
      };
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const turn = active;
          if (turn?.stream)
            yield* cancelBoxRun(turn.box, turn.stream, turn.runMarker).pipe(Effect.ignore);
          yield* Queue.shutdown(events);
        }),
      );
      return runtime;
    }),
  });
});
