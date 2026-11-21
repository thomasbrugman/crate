import {
  PositiveInt,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import type { IdAllocatorV2Derive } from "@t3tools/provider-core/server/IdAllocator";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import type { Chunk } from "@upstash/box";
import * as DateTime from "effect/DateTime";

type ToolItem = Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>;

export class BoxTurnTranslation {
  private text = "";
  private messageIndex = 0;
  private hasText = false;
  private finished: Extract<Chunk, { type: "finish" }> | undefined;
  private startedAt: DateTime.Utc;
  private tools: ToolItem[] = [];
  private itemOrdinal = 0;
  private messageOrdinal: number | undefined;
  private message: OrchestrationV2ConversationMessage;
  private turn: OrchestrationV2ProviderTurn;
  private terminal = false;
  readonly thread: OrchestrationV2ProviderThread;
  private readonly input: ProviderAdapterV2TurnInput;
  private readonly ids: IdAllocatorV2Derive;

  constructor(input: ProviderAdapterV2TurnInput, ids: IdAllocatorV2Derive, now: DateTime.Utc) {
    this.input = input;
    this.ids = ids;
    this.startedAt = now;
    this.thread = input.providerThread;
    const nativeItemId = `${input.attemptId}:assistant`;
    this.message = {
      id: ids.messageFromProviderItem({ driver: input.providerThread.driver, nativeItemId }),
      threadId: input.threadId,
      runId: input.runId,
      nodeId: input.rootNodeId,
      role: "assistant",
      text: "",
      attachments: [],
      streaming: true,
      createdBy: "agent",
      creationSource: "provider",
      createdAt: now,
      updatedAt: now,
    };
    this.turn = {
      id: ids.providerTurn({ driver: input.providerThread.driver, nativeTurnId: input.attemptId }),
      providerThreadId: input.providerThread.id,
      nodeId: input.rootNodeId,
      runAttemptId: input.attemptId,
      nativeTurnRef: null,
      ordinal: PositiveInt.make(input.providerTurnOrdinal),
      status: "running",
      startedAt: now,
      completedAt: null,
    };
  }

  get providerTurnId() {
    return this.turn.id;
  }
  get sessionId() {
    return this.finished?.sessionId;
  }

  get hasFinished() {
    return this.finished !== undefined;
  }

  private node(
    status: OrchestrationV2ExecutionNode["status"],
    now: DateTime.Utc,
  ): OrchestrationV2ExecutionNode {
    return {
      id: this.input.rootNodeId,
      threadId: this.input.threadId,
      runId: this.input.runId,
      parentNodeId: null,
      rootNodeId: this.input.rootNodeId,
      kind: "root_turn",
      status,
      countsForRun: true,
      providerThreadId: this.thread.id,
      providerTurnId: this.turn.id,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: this.startedAt,
      completedAt: status === "running" ? null : now,
    };
  }

  start(now: DateTime.Utc): ProviderAdapterV2Event[] {
    return [
      {
        type: "provider_turn.updated",
        driver: this.thread.driver,
        threadId: this.input.threadId,
        providerTurn: this.turn,
      },
      { type: "node.updated", driver: this.thread.driver, node: this.node("running", now) },
    ];
  }

  private messageEvents(now: DateTime.Utc, streaming: boolean): ProviderAdapterV2Event[] {
    this.message = { ...this.message, text: this.text, streaming, updatedAt: now };
    this.messageOrdinal ??= ++this.itemOrdinal;
    return [
      { type: "message.updated", driver: this.thread.driver, message: this.message },
      {
        type: "turn_item.updated",
        driver: this.thread.driver,
        turnItem: {
          id: this.ids.turnItemFromProviderItem({
            driver: this.thread.driver,
            nativeItemId: `${this.input.attemptId}:assistant:${this.messageIndex}`,
          }),
          threadId: this.input.threadId,
          runId: this.input.runId,
          nodeId: this.input.rootNodeId,
          providerThreadId: this.thread.id,
          providerTurnId: this.turn.id,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: this.messageOrdinal,
          status: streaming ? "running" : "completed",
          title: null,
          startedAt: this.message.createdAt,
          completedAt: streaming ? null : now,
          updatedAt: now,
          type: "assistant_message",
          messageId: this.message.id,
          text: this.text,
          streaming,
        },
      },
    ];
  }

  accept(chunk: Chunk, now: DateTime.Utc): ProviderAdapterV2Event[] {
    if (this.terminal) return [];
    switch (chunk.type) {
      case "start":
        this.turn = {
          ...this.turn,
          nativeTurnRef: {
            driver: this.thread.driver,
            nativeId: chunk.runId,
            strength: "strong",
          },
        };
        return [
          {
            type: "provider_turn.updated",
            driver: this.thread.driver,
            threadId: this.input.threadId,
            providerTurn: this.turn,
          },
        ];
      case "text-delta":
        this.hasText ||= chunk.text.length > 0;
        this.text += chunk.text;
        return this.messageEvents(now, true);
      case "tool-call": {
        const events = this.text ? this.messageEvents(now, false) : [];
        if (this.messageOrdinal !== undefined) {
          this.text = "";
          this.messageOrdinal = undefined;
          this.messageIndex++;
          this.message = {
            ...this.message,
            id: this.ids.messageFromProviderItem({
              driver: this.thread.driver,
              nativeItemId: `${this.input.attemptId}:assistant:${this.messageIndex}`,
            }),
            text: "",
            streaming: true,
            createdAt: now,
            updatedAt: now,
          };
        }
        const ordinal = ++this.itemOrdinal;
        const item: ToolItem = {
          id: this.ids.turnItemFromProviderItem({
            driver: this.thread.driver,
            nativeItemId: `${this.input.attemptId}:tool:${ordinal}`,
          }),
          threadId: this.input.threadId,
          runId: this.input.runId,
          nodeId: this.input.rootNodeId,
          providerThreadId: this.thread.id,
          providerTurnId: this.turn.id,
          nativeItemRef: chunk.toolCallId
            ? { driver: this.thread.driver, nativeId: chunk.toolCallId, strength: "weak" }
            : null,
          parentItemId: null,
          ordinal,
          status: "running",
          title: chunk.toolName,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "dynamic_tool",
          toolName: chunk.toolName,
          input: chunk.input,
        };
        this.tools.push(item);
        return [
          ...events,
          { type: "turn_item.updated", driver: this.thread.driver, turnItem: item },
        ];
      }
      case "tool-result": {
        const candidates = this.tools.filter((item) => item.status === "running");
        const index = this.tools.findIndex(
          (item) =>
            item.status === "running" &&
            (chunk.toolCallId
              ? item.nativeItemRef?.nativeId === chunk.toolCallId
              : candidates.length === 1 && item.nativeItemRef === null),
        );
        const previous = this.tools[index];
        if (!previous) return [];
        const item: ToolItem = {
          ...previous,
          status: "completed",
          output: chunk.output,
          completedAt: now,
          updatedAt: now,
        };
        this.tools[index] = item;
        return [{ type: "turn_item.updated", driver: this.thread.driver, turnItem: item }];
      }
      case "finish":
        this.finished = chunk;
        if (!this.hasText) this.text = chunk.output;
        return [];
      default:
        return [];
    }
  }

  complete(
    now: DateTime.Utc,
    interrupted = false,
    failed = false,
    failureMessage = "The connection to the Box ended before the agent finished. Send a message to retry.",
  ): ProviderAdapterV2Event[] {
    if (this.terminal) return [];
    this.terminal = true;
    const status = interrupted ? "interrupted" : failed || !this.finished ? "failed" : "completed";
    const usage = this.finished?.usage;
    this.turn = {
      ...this.turn,
      status,
      completedAt: now,
      ...(usage
        ? {
            tokenUsage: {
              ...usage,
              usedTokens: usage.inputTokens + usage.outputTokens,
              updatedAt: DateTime.formatIso(now),
            },
          }
        : {}),
    };
    const events: ProviderAdapterV2Event[] = this.tools
      .filter((item) => item.status === "running")
      .map((item) => ({
        type: "turn_item.updated",
        driver: this.thread.driver,
        turnItem: {
          ...item,
          status: status === "completed" ? "failed" : status,
          completedAt: now,
          updatedAt: now,
        },
      }));
    if (this.text) events.push(...this.messageEvents(now, false));
    events.push(
      {
        type: "provider_turn.updated",
        driver: this.thread.driver,
        threadId: this.input.threadId,
        providerTurn: this.turn,
      },
      { type: "node.updated", driver: this.thread.driver, node: this.node(status, now) },
    );
    const terminal = {
      type: "turn.terminal" as const,
      driver: this.thread.driver,
      providerThreadId: this.thread.id,
      providerTurnId: this.turn.id,
      runOrdinal: PositiveInt.make(this.input.runOrdinal),
      threadDisposition: "reusable" as const,
    };
    events.push(
      status === "failed"
        ? {
            ...terminal,
            status,
            failureItemOrdinal: PositiveInt.make(this.itemOrdinal + 1),
            failure: {
              class: "provider_error",
              message: failureMessage,
              code: null,
              retryable: null,
            },
          }
        : { ...terminal, status, failure: null },
    );
    return events;
  }
}
