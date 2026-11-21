// @effect-diagnostics nodeBuiltinImport:off - exercises cleanup against a disposable Git repository.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ContextHandoffId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { knownProviderFailureMessage } from "@t3tools/provider-core/server/failure";
import {
  ProviderAdapterV2Event,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { BoxError, type BoxConfig, type Chunk } from "@upstash/box";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { BOX_HARNESS_DRIVER_KINDS, type BoxHarness } from "../harnesses.ts";
import { makeUpstashBoxAdapter } from "./adapter.ts";
import { BoxApi, type BoxHandle, type BoxStream } from "./BoxApi.ts";
import { commandCodeHarness } from "./harness.ts";

const instanceId = ProviderInstanceId.make("box-test");
const agentApiKey = "agent-credential-789";
const threadId = ThreadId.make("thread-box-test");
const modelSelection = { instanceId, model: "default" };
const runtimePolicy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
} as const;
const finish: Chunk = {
  type: "finish",
  output: "hello",
  usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 },
  sessionId: "cc-session",
};

const setup = Effect.fn("test.setupBox")(function* (
  stream: BoxStream | (() => Promise<BoxStream>),
  deleteBox?: () => Promise<void>,
  harness: BoxHarness = "commandCode",
  command?: BoxHandle["exec"]["command"],
  apiKey = "test-key",
) {
  const commands: string[] = [];
  const prompts: string[] = [];
  const harnesses: string[] = [];
  const lookup: {
    error?: unknown;
    createError?: unknown;
    exec?: BoxHandle["exec"]["command"];
    statusError?: unknown;
    streamError?: unknown;
    resumeError?: unknown;
    replacement?: BoxHandle;
    resumes: number;
  } = { resumes: 0 };
  const createdSizes: BoxConfig["size"][] = [];
  const box: BoxHandle = {
    id: "box-123",
    agent: {
      stream: async ({ prompt }) => {
        prompts.push(prompt);
        if (lookup.error) throw lookup.error;
        if (lookup.streamError) throw lookup.streamError;
        return typeof stream === "function" ? await stream() : stream;
      },
    },
    exec: {
      command: async (text) => {
        commands.push(text);
        return lookup.exec
          ? lookup.exec(text)
          : command
            ? command(text)
            : { stdout: "", exitCode: 0 };
      },
    },
    files: {
      write: async ({ content }) => {
        harnesses.push(content);
      },
    },
    delete: deleteBox ?? (async () => undefined),
    resume: async () => {
      lookup.resumes++;
      if (lookup.resumeError) throw lookup.resumeError;
      lookup.streamError = undefined;
    },
    getStatus: async () => {
      if (lookup.statusError) throw lookup.statusError;
      return { status: "idle" };
    },
  };
  const adapter = yield* makeUpstashBoxAdapter(
    instanceId,
    { driver: BOX_HARNESS_DRIVER_KINDS[harness], harness, agentApiKey },
    Effect.succeed({ apiKey, templateBoxName: "cc-harness", size: "small" }),
  ).pipe(
    Effect.provide(IdAllocator.layer),
    Effect.provideService(BoxApi, {
      get: async (id) => {
        if (lookup.error) throw lookup.error;
        if (id.startsWith("t3-") && lookup.statusError) throw lookup.statusError;
        return lookup.replacement ?? box;
      },
      create: async ({ size }) => {
        if (lookup.createError) throw lookup.createError;
        createdSizes.push(size);
        lookup.error = undefined;
        lookup.statusError = undefined;
        return lookup.replacement ?? box;
      },
      list: async () => [],
      checkModelKey: async () => 200,
    }),
  );
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("box-session"),
    modelSelection,
    runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const now = yield* DateTime.now;
  const turn: ProviderAdapterV2TurnInput = {
    appThread: {
      id: threadId,
      projectId: ProjectId.make("box-project"),
      title: "Box",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    threadId,
    runId: RunId.make("box-run"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make("box-attempt"),
    rootNodeId: NodeId.make("box-root"),
    providerThread,
    message: {
      messageId: MessageId.make("box-user-message"),
      text: "hello",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection,
    runtimePolicy,
  };
  return { runtime, turn, prompts, adapter, lookup, box, commands, harnesses, createdSizes };
});

it.effect("explains missing and rejected API keys without exposing upstream details", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const harness of ["commandCode", "claudeCode", "codex"] as const) {
        const { runtime, lookup, turn } = yield* setup(fakeStream([]), undefined, harness);
        for (const status of [401, 403, 500]) {
          lookup.error = new BoxError("private upstream body with test-key", status);
          const error = yield* runtime
            .ensureThread({ threadId, modelSelection, runtimePolicy })
            .pipe(Effect.flip);
          assert.equal(
            knownProviderFailureMessage(error),
            status === 500
              ? undefined
              : "Upstash Box rejected the API key. Check it in Settings → Providers.",
          );
          assert.notInclude(JSON.stringify(error), "private upstream body");
          assert.notInclude(JSON.stringify(error), "test-key");
        }
        const missing = yield* setup(fakeStream([]), undefined, harness, undefined, "").pipe(
          Effect.flip,
        );
        assert.equal(
          knownProviderFailureMessage(missing),
          "Upstash Box API key is missing. Add it in Settings → Providers.",
        );
        lookup.error = new BoxError("private upstream body with test-key", 401);
        const resumed = yield* runtime
          .resumeThread({ providerThread: turn.providerThread })
          .pipe(Effect.flip);
        assert.equal(
          knownProviderFailureMessage(resumed),
          "Upstash Box rejected the API key. Check it in Settings → Providers.",
        );
        lookup.error = new BoxError("missing", 404);
        lookup.createError = new BoxError("private upstream body with test-key", 401);
        const recreated = yield* runtime
          .resumeThread({ providerThread: turn.providerThread })
          .pipe(Effect.flip);
        assert.equal(
          knownProviderFailureMessage(recreated),
          "Upstash Box rejected the API key. Check it in Settings → Providers.",
        );
        assert.notInclude(JSON.stringify(recreated), "private upstream body");
        assert.notInclude(JSON.stringify(recreated), "test-key");
      }
    }),
  ),
);

it.effect("uses the saved Box size for provisioning and reprovisioning", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { runtime, turn, lookup, createdSizes } = yield* setup(fakeStream([]));
      lookup.error = new BoxError("Box not found", 404);
      yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
      lookup.error = new BoxError("Box not found", 404);
      yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: { ...runtimePolicy, boxSize: "medium" },
      });
      lookup.error = new BoxError("Box not found", 404);
      yield* runtime.resumeThread({
        providerThread: turn.providerThread,
        runtimePolicy: { ...runtimePolicy, boxSize: "large" },
      });
      assert.deepEqual(createdSizes, ["small", "medium", "large"]);
    }),
  ),
);

it.live("retains idle Boxes containing only gitignored work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const home = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "box-saved-work-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const repo = NodePath.join(home, "repo");
      yield* Effect.promise(() => NodeFSP.mkdir(repo));
      for (const name of [".claude", ".codex", ".cursor", ".local"]) {
        const path = NodePath.join(home, name);
        yield* Effect.promise(() => NodeFSP.mkdir(path));
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(path, "config.json"), "{}"));
      }
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(repo, ".gitignore"), ".env\n*.sqlite\n"),
      );
      yield* Effect.sync(() => {
        const git = (...args: string[]) =>
          NodeChildProcess.execFileSync("git", args, { cwd: repo, stdio: "pipe" });
        git("init");
        git("add", ".gitignore");
        git(
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "-m",
          "initial",
        );
        git("update-ref", "refs/remotes/origin/main", "HEAD");
      });
      let deleted = 0;
      const { adapter, turn } = yield* setup(
        fakeStream([]),
        async () => {
          deleted++;
        },
        "commandCode",
        async (command) => {
          if (!command.includes("git stash")) return { stdout: "", exitCode: 0 };
          const result = NodeChildProcess.spawnSync(
            "sh",
            ["-c", command.replaceAll("/workspace/home", home)],
            { encoding: "utf8" },
          );
          return { stdout: result.stdout, exitCode: result.status ?? 1 };
        },
      );
      assert.isTrue(yield* adapter.deleteIdleThread!(turn.providerThread));
      assert.equal(deleted, 1);
      for (const name of [".env", "local.sqlite"]) {
        const path = NodePath.join(repo, name);
        yield* Effect.promise(() => NodeFSP.writeFile(path, "fixture"));
        assert.isFalse(yield* adapter.deleteIdleThread!(turn.providerThread));
        assert.equal(deleted, 1);
        yield* Effect.promise(() => NodeFSP.unlink(path));
      }
      yield* Effect.promise(() => NodeFSP.rm(repo, { recursive: true }));
      assert.isTrue(yield* adapter.deleteIdleThread!(turn.providerThread));
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(home, "notes.txt"), "fixture"));
      assert.isFalse(yield* adapter.deleteIdleThread!(turn.providerThread));
      assert.equal(deleted, 2);
    }),
  ),
);

it.effect("deletes native Boxes, keeps idle Boxes with unsaved work, and sanitizes failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let deleted = 0;
      let exitCode = 0;
      const { adapter, turn, lookup, commands } = yield* setup(
        fakeStream([]),
        async () => {
          deleted++;
        },
        "commandCode",
        async (command) => ({ stdout: "", exitCode: command.includes("git stash") ? exitCode : 0 }),
      );
      yield* adapter.deleteThread!(turn.providerThread);
      assert.equal(deleted, 1);
      lookup.error = new BoxError("private upstream body", 404);
      yield* adapter.deleteThread!(turn.providerThread);
      assert.equal(deleted, 1);
      lookup.error = new Error("private upstream body");
      const error = yield* adapter.deleteThread!(turn.providerThread).pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterProtocolError");
      assert.notInclude(JSON.stringify(error), "private upstream body");
      yield* adapter.deleteThread!({
        ...turn.providerThread,
        nativeThreadRef: null,
        appThreadId: null,
      });
      lookup.error = undefined;
      exitCode = 1;
      assert.isFalse(yield* adapter.deleteIdleThread!(turn.providerThread));
      assert.equal(deleted, 1);
      exitCode = 0;
      assert.isTrue(yield* adapter.deleteIdleThread!(turn.providerThread));
      assert.equal(deleted, 2);
      lookup.error = new BoxError("private upstream body", 404);
      assert.isTrue(yield* adapter.deleteIdleThread!(turn.providerThread));
      assert.lengthOf(
        commands.filter((text) => text.includes("git stash")),
        2,
      );
    }),
  ),
);

function fakeStream(chunks: ReadonlyArray<Chunk>, error: unknown = false): BoxStream {
  return {
    id: "native-run",
    cancel: async () => undefined,
    async *[Symbol.asyncIterator]() {
      yield* chunks;
      if (error) throw error === true ? new Error("private upstream error must not escape") : error;
    },
  };
}

it.effect("cancels a run that finishes starting while its session shuts down", () =>
  Effect.gen(function* () {
    const starting = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<BoxStream>();
    let cancelled = 0;
    let cleaned = 0;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { runtime, turn, lookup } = yield* setup(async () => {
          starting.resolve();
          return ready.promise;
        });
        lookup.exec = async () => {
          assert.isAbove(cancelled, 0);
          cleaned++;
          return { stdout: "", exitCode: 0 };
        };
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "provider_thread.updated"),
          Stream.runDrain,
        );
        yield* runtime.startTurn({
          ...turn,
          providerThread: { ...turn.providerThread, status: "active" },
        });
        yield* Effect.promise(() => starting.promise);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() =>
            ready.resolve({
              ...fakeStream([]),
              cancel: async () => {
                cancelled++;
              },
            }),
          ),
        );
        const startingEvents = yield* runtime.events.pipe(
          Stream.takeUntil(
            (event) => event.type === "node.updated" && event.node.status === "running",
          ),
          Stream.runCollect,
        );
        assert.isFalse(
          startingEvents.some(
            (event) =>
              event.type === "provider_thread.updated" && event.providerThread.status === "idle",
          ),
          "Starting a live turn must not make the thread ineligible for restart continuation",
        );
      }),
    );
    assert.equal(cancelled, 1);
    assert.isAbove(cleaned, 0);
  }),
);

const decodeEvent = Schema.decodeEffect(ProviderAdapterV2Event);
const collect = <E>(events: Stream.Stream<ProviderAdapterV2Event, E>) =>
  events.pipe(
    Stream.takeUntil((event) => event.type === "turn.terminal"),
    Stream.runCollect,
  );

it.effect.each(["commandCode", "claudeCode", "codex"] as const)(
  "recreates a deleted Box before a follow-up even when the thread stays loaded (%s)",
  (harness) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { runtime, turn, lookup, box, createdSizes } = yield* setup(
          fakeStream([finish]),
          undefined,
          harness,
        );
        assert.equal(runtime.driver, BOX_HARNESS_DRIVER_KINDS[harness]);
        assert.isTrue(runtime.revalidateLoadedThreads);
        lookup.streamError = new BoxError("deleted", 404);
        yield* runtime.startTurn(turn);
        const failed = yield* collect(runtime.events);
        assert.equal(failed.at(-1)?.type, "turn.terminal");
        assert.equal(failed.find((e) => e.type === "turn.terminal")?.status, "failed");
        assert.isFalse(
          failed.some((e) => e.type === "turn_item.updated" && e.turnItem.type === "system_notice"),
        );
        lookup.streamError = undefined;
        lookup.statusError = new BoxError("deleted", 404);
        lookup.replacement = {
          ...box,
          id: "replacement-box",
          agent: { stream: async () => fakeStream([finish]) },
        };
        const replacement = yield* runtime.resumeThread({
          providerThread: turn.providerThread,
          threadId,
          modelSelection,
          runtimePolicy: { ...runtimePolicy, boxSize: "large" },
        });
        assert.deepEqual(createdSizes, ["large"]);
        assert.equal(replacement.nativeThreadRef?.nativeId, "replacement-box");
        yield* runtime.startTurn({ ...turn, providerThread: replacement });
        const recovered = yield* collect(runtime.events);
        assert.equal(runtime.providerSession.status, "ready");
        assert.equal(recovered.find((e) => e.type === "turn.terminal")?.status, "completed");
        const thread = recovered.find(
          (e) =>
            e.type === "provider_thread.updated" &&
            e.providerThread.nativeThreadRef?.nativeId === "replacement-box",
        );
        assert.isDefined(thread);
        if (thread?.type !== "provider_thread.updated") return;
        assert.equal(thread.providerThread.id, turn.providerThread.id);
        assert.isNull(thread.providerThread.nativeConversationHeadRef);
        assert.equal(lookup.resumes, 0);
        const notices = recovered.filter(
          (e) => e.type === "turn_item.updated" && e.turnItem.type === "system_notice",
        );
        assert.lengthOf(notices, 1);
        const notice = notices[0];
        if (notice?.type !== "turn_item.updated" || notice.turnItem.type !== "system_notice")
          return;
        assert.equal(notice.turnItem.level, "warning");
        assert.equal(
          notice.turnItem.message,
          "This thread's Box was gone, so a new one was started. The agent doesn't have the earlier conversation, and uncommitted changes from the old Box are lost.",
        );
        assert.equal(notice.turnItem.threadId, turn.threadId);
        assert.equal(notice.turnItem.runId, turn.runId);
        for (const event of recovered) yield* decodeEvent(event);
        yield* runtime.startTurn({ ...turn, providerThread: thread.providerThread });
        const next = yield* collect(runtime.events);
        assert.isFalse(
          next.some((e) => e.type === "turn_item.updated" && e.turnItem.type === "system_notice"),
        );
      }),
    ),
);

it.effect(
  "resumes a Box rejecting new runs after shutdown without replaying a started stream",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const [status, resumeFails] of [
          [409, false],
          [401, false],
          [409, true],
        ] as const) {
          for (const harness of ["commandCode", "claudeCode", "codex"] as const) {
            const { adapter, turn, lookup } = yield* setup(
              fakeStream([finish]),
              undefined,
              harness,
            );
            const runtime = yield* adapter.openSession({
              threadId,
              providerSessionId: ProviderSessionId.make("restarted-session"),
              modelSelection,
              runtimePolicy,
            });
            yield* runtime.resumeThread({ providerThread: turn.providerThread });
            lookup.streamError = new BoxError("private upstream error", status);
            if (resumeFails) lookup.resumeError = new Error("private upstream error");
            yield* runtime.startTurn(turn);
            const events = yield* collect(runtime.events);
            assert.equal(
              events.find((e) => e.type === "turn.terminal")?.status,
              status === 409 && !resumeFails ? "completed" : "failed",
            );
            assert.equal(lookup.resumes, status === 409 ? 1 : 0);
            assert.notInclude(JSON.stringify(events), "private upstream error");
          }
        }
      }),
    ),
);

it.effect("publishes setup status and clears it on success or failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { runtime, lookup } = yield* setup(fakeStream([]));
      assert.equal(runtime.providerSession.status, "ready");
      lookup.error = new Error("private bootstrap failure");
      yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy }).pipe(Effect.flip);
      assert.equal(runtime.providerSession.status, "error");
      const events = yield* runtime.events.pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "provider_session.updated" && event.providerSession.status === "error",
        ),
        Stream.runCollect,
      );
      assert.deepEqual(
        events
          .filter((event) => event.type === "provider_session.updated")
          .map((event) => [
            event.providerSession.status,
            event.providerSession.extensionStatuses?.map((status) => status.text).join(),
          ]),
        [
          ["starting", ""],
          ["starting", "Connecting to the Box"],
          ["starting", "Checking the Box setup"],
          ["ready", ""],
          ["starting", ""],
          ["starting", "Connecting to the Box"],
          ["error", ""],
        ],
      );
      assert.notInclude(JSON.stringify(events), "private bootstrap failure");
    }),
  ),
);

it.effect(
  "translates a fake stream into accumulated text, paired tools, continuation identity and usage",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { runtime, turn, prompts, harnesses } = yield* setup(
          fakeStream([
            { type: "start", runId: "native-run" },
            { type: "tool-result", output: "orphan" },
            { type: "tool-call", toolCallId: "read", toolName: "Read", input: { path: "first" } },
            {
              type: "tool-call",
              toolCallId: "write",
              toolName: "Write",
              input: { path: "second" },
            },
            { type: "tool-result", output: "ambiguous" },
            { type: "tool-result", toolCallId: "unknown", output: "orphan" },
            {
              type: "tool-result",
              toolCallId: "write",
              output: [{ type: "text", text: "wrote second" }],
            },
            { type: "tool-result", toolCallId: "read", output: "read first" },
            { type: "text-delta", text: "hel" },
            { type: "text-delta", text: "lo" },
            finish,
            { type: "stats", cpuNs: 1, memoryPeakBytes: 1 },
          ]),
        );
        const text = "Earlier context\n\nhello";
        yield* runtime.resumeThread({ providerThread: turn.providerThread });
        assert.deepEqual(harnesses, [commandCodeHarness, commandCodeHarness]);
        yield* runtime.startTurn({
          ...turn,
          providerThread: {
            ...turn.providerThread,
            id: ProviderThreadId.make("persisted-placeholder"),
          },
          message: { ...turn.message, text },
          inlineContextLength: text.length - 5,
        });
        const events = yield* collect(runtime.events);
        assert.deepEqual(prompts, [
          `t3stash-run:${Buffer.from(turn.attemptId).toString("hex")}\n${text}`,
        ]);
        for (const event of events) yield* decodeEvent(event);
        const messages = events
          .filter((event) => event.type === "message.updated")
          .map((event) => event.message);
        assert.deepEqual(
          messages.map((message) => [message.text, message.streaming]),
          [
            ["hel", true],
            ["hello", true],
            ["hello", false],
          ],
        );
        assert.isTrue(messages.every((message) => message.id === messages[0]?.id));
        const assistantItems = events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
            ? [event.turnItem]
            : [],
        );
        assert.deepEqual(
          assistantItems.map((item) => [item.text, item.streaming, item.messageId]),
          messages.map((message) => [message.text, message.streaming, message.id]),
        );
        assert.isTrue(assistantItems.every((item) => item.id === assistantItems[0]?.id));
        const completedTools = events
          .filter((event) => event.type === "turn_item.updated")
          .filter(
            (event) =>
              event.turnItem.type === "dynamic_tool" && event.turnItem.status === "completed",
          );
        assert.deepEqual(
          completedTools.map((event) => event.turnItem.title),
          ["Write", "Read"],
        );
        assert.deepEqual(
          completedTools.map((event) =>
            event.turnItem.type === "dynamic_tool" ? event.turnItem.output : null,
          ),
          [[{ type: "text", text: "wrote second" }], "read first"],
        );
        const turns = events.filter((event) => event.type === "provider_turn.updated");
        assert.deepEqual(turns.at(-1)?.providerTurn.tokenUsage, {
          inputTokens: 10,
          outputTokens: 2,
          cachedInputTokens: 4,
          usedTokens: 12,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        });
        const thread = events
          .filter((event) => event.type === "provider_thread.updated")
          .at(-1)?.providerThread;
        assert.equal(thread?.nativeThreadRef?.nativeId, "box-123");
        assert.equal(thread?.nativeConversationHeadRef?.nativeId, "cc-session");
        assert.equal(events.at(-1)?.type, "turn.terminal");
        assert.equal(
          events.filter((event) => event.type === "turn.terminal")[0]?.status,
          "completed",
        );
        const current = {
          ...turn.providerThread,
          firstRunOrdinal: 1,
          lastRunOrdinal: 2,
          handoffIds: [ContextHandoffId.make("follow-up-handoff")],
        };
        const attemptId = RunAttemptId.make("follow-up-attempt");
        yield* runtime.startTurn({
          ...turn,
          attemptId,
          providerThread: current,
          providerTurnOrdinal: 2,
        });
        const followUp = yield* collect(runtime.events);
        const saved = followUp
          .filter((event) => event.type === "provider_thread.updated")
          .at(-1)?.providerThread;
        assert.equal(saved?.firstRunOrdinal, current.firstRunOrdinal);
        assert.equal(saved?.lastRunOrdinal, current.lastRunOrdinal);
        assert.deepEqual(saved?.handoffIds, current.handoffIds);
        assert.equal(saved?.nativeConversationHeadRef?.nativeId, "cc-session");
        assert.equal(prompts[1], `t3stash-run:${Buffer.from(attemptId).toString("hex")}\nhello`);
      }),
    ),
);

it.effect("splits assistant messages around tools without duplicating finish output", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const fail of [false, true]) {
        const { runtime, turn } = yield* setup(
          fakeStream(
            [
              { type: "text-delta", text: "editing." },
              { type: "tool-call", toolName: "Write", input: {} },
              { type: "tool-result", output: "done" },
              { type: "tool-call", toolName: "Read", input: {} },
              { type: "tool-result", output: "done" },
              { type: "text-delta", text: "Default " },
              { type: "text-delta", text: "verify." },
              { type: "tool-call", toolName: "Check", input: {} },
              { type: "tool-result", output: "done" },
              ...(fail ? [] : [{ ...finish, output: "editing.Default verify." }]),
            ],
            fail,
          ),
        );
        yield* runtime.startTurn(turn);
        const events = yield* collect(runtime.events);
        for (const event of events) yield* decodeEvent(event);
        const messages = events.flatMap((event) =>
          event.type === "message.updated" && !event.message.streaming ? [event.message] : [],
        );
        assert.deepEqual(
          messages.map((message) => message.text),
          ["editing.", "Default verify."],
        );
        assert.equal(new Set(messages.map((message) => message.id)).size, 2);
        const items = events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.status === "completed"
            ? [event.turnItem]
            : [],
        );
        assert.deepEqual(
          items.map((item) => [item.type, item.ordinal]),
          [
            ["assistant_message", 1],
            ["dynamic_tool", 2],
            ["dynamic_tool", 3],
            ["assistant_message", 4],
            ["dynamic_tool", 5],
          ],
        );
        assert.equal(new Set(items.map((item) => item.id)).size, 5);
        assert.deepEqual(
          items.flatMap((item) => (item.type === "assistant_message" ? [item.messageId] : [])),
          messages.map((message) => message.id),
        );
      }
    }),
  ),
);

it.effect.each(["commandCode", "claudeCode", "codex"] as const)(
  "accepts an empty answer and distinguishes failed streams without leaking upstream errors (%s)",
  (harness) =>
    Effect.scoped(
      Effect.gen(function* () {
        const connection =
          "The connection to the Box ended before the agent finished. Send a message to retry.";
        const gone = "This thread's Box stopped mid-turn. Send a message to start a new one.";
        for (const [stream, status, message, statusError] of [
          [fakeStream([{ ...finish, output: "" }]), "completed", undefined, undefined],
          [fakeStream([]), "failed", connection, undefined],
          [
            fakeStream([{ type: "text-delta", text: "partial" }], true),
            "failed",
            connection,
            undefined,
          ],
          [
            fakeStream([], new BoxError("harness exited")),
            "failed",
            "The Box agent reported an error: harness exited. Send a message to retry.",
            undefined,
          ],
          [
            fakeStream([], new BoxError("")),
            "failed",
            "The Box agent reported an error. Send a message to retry.",
            undefined,
          ],
          [fakeStream([], new BoxError("private upstream body", 404)), "failed", gone, undefined],
          [
            async () => {
              throw new BoxError("private upstream body", 404);
            },
            "failed",
            gone,
            undefined,
          ],
          [
            async () => {
              throw new BoxError("private upstream body", 503);
            },
            "failed",
            connection,
            undefined,
          ],
          [
            async () => {
              throw new BoxError("private upstream body");
            },
            "failed",
            connection,
            undefined,
          ],
          [
            fakeStream([], new BoxError("private upstream body", 403)),
            "failed",
            connection,
            undefined,
          ],
          [
            fakeStream(
              [],
              new BoxError("Stream timed out", undefined, {
                cause: new Error("private upstream cause"),
              }),
            ),
            "failed",
            connection,
            undefined,
          ],
          [fakeStream([], true), "failed", gone, new BoxError("private upstream body", 404)],
          [fakeStream([]), "failed", gone, new BoxError("private upstream body", 404)],
          [
            fakeStream([], true),
            "failed",
            connection,
            new Error("private upstream status failure"),
          ],
        ] as const) {
          const { runtime, turn, lookup } = yield* setup(stream, undefined, harness);
          lookup.statusError = statusError;
          yield* runtime.startTurn(turn);
          const events = yield* collect(runtime.events);
          for (const event of events) yield* decodeEvent(event);
          const terminals = events.filter((event) => event.type === "turn.terminal");
          assert.lengthOf(terminals, 1);
          assert.equal(terminals[0]?.status, status);
          assert.equal(terminals[0]?.failure?.message, message);
          assert.notInclude(JSON.stringify(events), "private upstream");
          assert.equal(lookup.resumes, 0);
          if (status === "failed")
            assert.isFalse(
              events.filter((event) => event.type === "message.updated").at(-1)?.message
                .streaming ?? false,
            );
        }
      }),
    ),
);

it.effect.each(["commandCode", "claudeCode", "codex"] as const)(
  "redacts and bounds only messages from agent stream error events (%s)",
  (harness) =>
    Effect.scoped(
      Effect.gen(function* () {
        const secret = "opaque_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        const { runtime, turn } = yield* setup(
          fakeStream(
            [],
            new BoxError(
              `harness failed: test-key ${agentApiKey} api_key=labelled-secret Bearer bearer-secret sk-abcdefghijklmnop ${secret} https://user:pass@example.test/path?token=url-secret\u001b[31m ${"detail ".repeat(80)}`,
            ),
          ),
          undefined,
          harness,
        );
        yield* runtime.startTurn(turn);
        const events = yield* collect(runtime.events);
        const terminal = events.find((event) => event.type === "turn.terminal");
        assert.equal(terminal?.status, "failed");
        const message = terminal?.failure?.message ?? "";
        assert.include(message, "The Box agent reported an error: harness failed:");
        assert.include(message, "[REDACTED]");
        assert.include(message, "…");
        assert.isAtMost(message.length, 270);
        for (const value of [
          "test-key",
          agentApiKey,
          "labelled-secret",
          "bearer-secret",
          "sk-abcdefghijklmnop",
          secret,
          "user:pass",
          "url-secret",
          "\u001b",
        ])
          assert.notInclude(JSON.stringify(events), value);
      }),
    ),
);

it.effect.each(["ok", "throw", "exit", "hang"] as const)(
  "cancels the active stream and interrupts despite %s cleanup",
  (cleanup) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cancelled = Promise.withResolvers<void>();
        const releaseCleanup = Promise.withResolvers<{ stdout: string; exitCode: number }>();
        let cancelCount = 0;
        const order: string[] = [];
        const { runtime, turn, lookup } = yield* setup({
          id: "native-run",
          cancel: async () => {
            cancelCount++;
            order.push("cancel");
            cancelled.resolve();
          },
          async *[Symbol.asyncIterator]() {
            yield { type: "start", runId: "native-run" };
            await cancelled.promise;
          },
        });
        lookup.exec = async (command) => {
          assert.include(command, "t3stash-harness.mjs");
          order.push("kill");
          if (cleanup === "throw") throw new Error("private cleanup failure");
          if (cleanup === "hang") return releaseCleanup.promise;
          return { stdout: "", exitCode: cleanup === "exit" ? 1 : 0 };
        };
        yield* runtime.startTurn(turn);
        const started = yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "provider_turn.updated" && event.providerTurn.nativeTurnRef !== null,
          ),
          Stream.take(1),
          Stream.runCollect,
        );
        const event = started[0];
        assert.isDefined(event);
        if (event?.type !== "provider_turn.updated")
          return yield* Effect.die("Missing start event");
        const interrupt = yield* runtime
          .interruptTurn({
            providerThread: turn.providerThread,
            providerTurnId: event.providerTurn.id,
          })
          .pipe(Effect.forkChild);
        if (cleanup === "hang") {
          yield* TestClock.adjust("8 seconds");
          const finished = interrupt.pollUnsafe();
          releaseCleanup.resolve({ stdout: "", exitCode: 0 });
          assert.isDefined(finished);
        }
        yield* Fiber.join(interrupt);
        const events = yield* collect(runtime.events);
        assert.equal(cancelCount, 1);
        assert.deepEqual(order, ["cancel", "kill"]);
        assert.equal(
          events.filter((entry) => entry.type === "turn.terminal")[0]?.status,
          "interrupted",
        );
      }),
    ),
);
