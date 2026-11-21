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
import {
  ProviderAdapterV2Event,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { BoxError, type Chunk } from "@upstash/box";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { makeUpstashBoxAdapter } from "./adapter.ts";
import { BoxApi, type BoxHandle, type BoxStream } from "./BoxApi.ts";
import { commandCodeHarness } from "./harness.ts";

const instanceId = ProviderInstanceId.make("box-test");
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
) {
  const prompts: string[] = [];
  const harnesses: string[] = [];
  const lookup: { error?: unknown } = {};
  const box: BoxHandle = {
    id: "box-123",
    agent: {
      stream: async ({ prompt }) => {
        prompts.push(prompt);
        return typeof stream === "function" ? await stream() : stream;
      },
    },
    exec: { command: async () => ({ stdout: "", exitCode: 0 }) },
    files: {
      write: async ({ content }) => {
        harnesses.push(content);
      },
    },
    delete: deleteBox ?? (async () => undefined),
  };
  const adapter = yield* makeUpstashBoxAdapter(instanceId, {
    apiKey: "test-key",
    templateBoxName: "cc-harness",
    size: "small",
    model: "",
  }).pipe(
    Effect.provide(IdAllocator.layer),
    Effect.provideService(BoxApi, {
      get: async () => {
        if (lookup.error) throw lookup.error;
        return box;
      },
      create: async () => box,
      list: async () => [],
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
  return { runtime, turn, prompts, adapter, lookup, harnesses };
});

it.effect(
  "deletes native Boxes, tolerates missing identities and Boxes, and sanitizes failures",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let deleted = 0;
        const { adapter, turn, lookup } = yield* setup(fakeStream([]), async () => {
          deleted++;
        });
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
      }),
    ),
);

function fakeStream(chunks: ReadonlyArray<Chunk>, error = false): BoxStream {
  return {
    id: "native-run",
    cancel: async () => undefined,
    async *[Symbol.asyncIterator]() {
      yield* chunks;
      if (error) throw new Error("private upstream error must not escape");
    },
  };
}

it.effect("cancels a run that finishes starting while its session shuts down", () =>
  Effect.gen(function* () {
    const starting = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<BoxStream>();
    let cancelled = 0;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { runtime, turn } = yield* setup(async () => {
          starting.resolve();
          return ready.promise;
        });
        yield* runtime.startTurn(turn);
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
      }),
    );
    assert.equal(cancelled, 1);
  }),
);

const decodeEvent = Schema.decodeEffect(ProviderAdapterV2Event);
const collect = <E>(events: Stream.Stream<ProviderAdapterV2Event, E>) =>
  events.pipe(
    Stream.takeUntil((event) => event.type === "turn.terminal"),
    Stream.runCollect,
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
        assert.deepEqual(prompts, [text]);
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
        yield* runtime.startTurn({ ...turn, providerThread: current, providerTurnOrdinal: 2 });
        const followUp = yield* collect(runtime.events);
        const saved = followUp
          .filter((event) => event.type === "provider_thread.updated")
          .at(-1)?.providerThread;
        assert.equal(saved?.firstRunOrdinal, current.firstRunOrdinal);
        assert.equal(saved?.lastRunOrdinal, current.lastRunOrdinal);
        assert.deepEqual(saved?.handoffIds, current.handoffIds);
        assert.equal(saved?.nativeConversationHeadRef?.nativeId, "cc-session");
      }),
    ),
);

it.effect(
  "accepts an empty completed answer but fails an empty or throwing stream without leaking upstream errors",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const [stream, status] of [
          [fakeStream([{ ...finish, output: "" }]), "completed"],
          [fakeStream([]), "failed"],
          [fakeStream([{ type: "text-delta", text: "partial" }], true), "failed"],
        ] as const) {
          const { runtime, turn } = yield* setup(stream);
          yield* runtime.startTurn(turn);
          const events = yield* collect(runtime.events);
          for (const event of events) yield* decodeEvent(event);
          const terminals = events.filter((event) => event.type === "turn.terminal");
          assert.lengthOf(terminals, 1);
          assert.equal(terminals[0]?.status, status);
          assert.notInclude(JSON.stringify(events), "private upstream");
          if (status === "failed")
            assert.isFalse(
              events.filter((event) => event.type === "message.updated").at(-1)?.message
                .streaming ?? false,
            );
        }
      }),
    ),
);

it.effect("cancels the active stream and emits one interrupted terminal", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cancelled = Promise.withResolvers<void>();
      let cancelCount = 0;
      const { runtime, turn } = yield* setup({
        id: "native-run",
        cancel: async () => {
          cancelCount++;
          cancelled.resolve();
        },
        async *[Symbol.asyncIterator]() {
          yield { type: "start", runId: "native-run" };
          await cancelled.promise;
        },
      });
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
      if (event?.type !== "provider_turn.updated") return yield* Effect.die("Missing start event");
      yield* runtime.interruptTurn({
        providerThread: turn.providerThread,
        providerTurnId: event.providerTurn.id,
      });
      const events = yield* collect(runtime.events);
      assert.equal(cancelCount, 1);
      assert.equal(
        events.filter((entry) => entry.type === "turn.terminal")[0]?.status,
        "interrupted",
      );
    }),
  ),
);
