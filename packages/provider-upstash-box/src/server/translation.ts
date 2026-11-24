import {
  PlanId,
  PositiveInt,
  RuntimeRequestId,
  type OrchestrationV2PlanStep,
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

import type { BoxHarnessChunk, BoxPlanChunk } from "./BoxApi.ts";
import { BoxSubagents } from "./subagents.ts";

type ToolItem = Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>;
type ReasoningItem = Extract<OrchestrationV2TurnItem, { type: "reasoning" }>;
type TodoItem = Extract<OrchestrationV2TurnItem, { type: "todo_list" }>;

export class BoxTurnTranslation {
  private text = "";
  private messageIndex = 0;
  private hasText = false;
  private finished: Extract<Chunk, { type: "finish" }> | undefined;
  private startedAt: DateTime.Utc;
  private tools: ToolItem[] = [];
  private reasoning: ReasoningItem | undefined;
  private reasoningIndex = 0;
  private todo: TodoItem | undefined;
  private questionIndex = 0;
  private itemOrdinal = 0;
  private messageOrdinal: number | undefined;
  private message: OrchestrationV2ConversationMessage;
  private turn: OrchestrationV2ProviderTurn;
  private terminal = false;
  readonly thread: OrchestrationV2ProviderThread;
  private readonly input: ProviderAdapterV2TurnInput;
  private readonly ids: IdAllocatorV2Derive;
  private readonly subagents: BoxSubagents;

  constructor(input: ProviderAdapterV2TurnInput, ids: IdAllocatorV2Derive, now: DateTime.Utc) {
    this.input = input;
    this.ids = ids;
    this.subagents = new BoxSubagents(input, ids);
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

  private closeMessage(now: DateTime.Utc): ProviderAdapterV2Event[] {
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
    return events;
  }

  private closeReasoning(now: DateTime.Utc): ProviderAdapterV2Event[] {
    const item = this.reasoning;
    if (!item) return [];
    this.reasoning = undefined;
    return [
      {
        type: "turn_item.updated",
        driver: this.thread.driver,
        turnItem: {
          ...item,
          status: "completed",
          streaming: false,
          completedAt: now,
          updatedAt: now,
        },
      },
    ];
  }

  private itemFields(
    nativeItemId: string,
    nodeId: OrchestrationV2ExecutionNode["id"],
    now: DateTime.Utc,
  ) {
    return {
      id: this.ids.turnItemFromProviderItem({ driver: this.thread.driver, nativeItemId }),
      threadId: this.input.threadId,
      runId: this.input.runId,
      nodeId,
      providerThreadId: this.thread.id,
      providerTurnId: this.turn.id,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: ++this.itemOrdinal,
      title: null,
      startedAt: now,
      updatedAt: now,
    };
  }

  private childNode(
    nativeItemId: string,
    kind: OrchestrationV2ExecutionNode["kind"],
    status: OrchestrationV2ExecutionNode["status"],
    startedAt: DateTime.Utc,
    now: DateTime.Utc,
    runtimeRequestId: RuntimeRequestId | null = null,
  ): OrchestrationV2ExecutionNode {
    return {
      id: this.ids.nodeFromProviderItem({ driver: this.thread.driver, nativeItemId }),
      threadId: this.input.threadId,
      runId: this.input.runId,
      parentNodeId: this.input.rootNodeId,
      rootNodeId: this.input.rootNodeId,
      kind,
      status,
      countsForRun: false,
      providerThreadId: this.thread.id,
      providerTurnId: this.turn.id,
      nativeItemRef: null,
      runtimeRequestId,
      checkpointScopeId: null,
      startedAt,
      completedAt: status === "running" || status === "waiting" ? null : now,
    };
  }

  private todoEvents(item: TodoItem, now: DateTime.Utc): ProviderAdapterV2Event[] {
    const node = this.childNode(
      `${this.input.attemptId}:todo`,
      "todo_list",
      item.status === "running" ? "running" : item.status === "completed" ? "completed" : "failed",
      item.startedAt ?? now,
      now,
    );
    return [
      { type: "node.updated", driver: this.thread.driver, node },
      {
        type: "plan.updated",
        driver: this.thread.driver,
        plan: {
          id: item.planId,
          threadId: this.input.threadId,
          runId: this.input.runId,
          nodeId: node.id,
          kind: "todo_list",
          status: "active",
          steps: item.steps,
        },
      },
      { type: "turn_item.updated", driver: this.thread.driver, turnItem: item },
    ];
  }

  private plan(chunk: BoxPlanChunk, now: DateTime.Utc): ProviderAdapterV2Event[] {
    const events = [...this.closeReasoning(now), ...this.closeMessage(now)];
    const { attemptId } = this.input;
    switch (chunk.type) {
      case "todo": {
        const steps: OrchestrationV2PlanStep[] = chunk.steps.map((step, index) => ({
          id: String(index + 1),
          text: step.text,
          status: step.status,
        }));
        const nativeItemId = `${attemptId}:todo`;
        this.todo = this.todo
          ? { ...this.todo, steps, updatedAt: now }
          : {
              ...this.itemFields(
                nativeItemId,
                this.ids.nodeFromProviderItem({ driver: this.thread.driver, nativeItemId }),
                now,
              ),
              status: "running",
              completedAt: null,
              type: "todo_list",
              planId: PlanId.make(`plan:${this.thread.driver}:${nativeItemId}`),
              steps,
            };
        return [...events, ...this.todoEvents(this.todo, now)];
      }
      case "proposed-plan": {
        const nativeItemId = `${attemptId}:plan`;
        const node = this.childNode(nativeItemId, "plan", "completed", now, now);
        const planId = PlanId.make(`plan:${this.thread.driver}:${nativeItemId}`);
        return [
          ...events,
          { type: "node.updated", driver: this.thread.driver, node },
          {
            type: "plan.updated",
            driver: this.thread.driver,
            plan: {
              id: planId,
              threadId: this.input.threadId,
              runId: this.input.runId,
              nodeId: node.id,
              kind: "proposed_plan",
              status: "active",
              markdown: chunk.markdown,
            },
          },
          {
            type: "turn_item.updated",
            driver: this.thread.driver,
            turnItem: {
              ...this.itemFields(nativeItemId, node.id, now),
              status: "completed",
              completedAt: now,
              type: "proposed_plan",
              planId,
              markdown: chunk.markdown,
              streaming: false,
            },
          },
        ];
      }
      case "question": {
        const nativeItemId = `${attemptId}:question:${this.questionIndex++}`;
        const requestId = RuntimeRequestId.make(
          `runtime-request:${this.thread.driver}:${nativeItemId}`,
        );
        const node = this.childNode(
          nativeItemId,
          "user_input_request",
          "waiting",
          now,
          now,
          requestId,
        );
        const nativeRequestRef = {
          driver: this.thread.driver,
          nativeId: chunk.toolCallId ?? nativeItemId,
          strength: chunk.toolCallId ? ("strong" as const) : ("weak" as const),
        };
        return [
          ...events,
          { type: "node.updated", driver: this.thread.driver, node },
          {
            type: "runtime_request.updated",
            driver: this.thread.driver,
            threadId: this.input.threadId,
            runtimeRequest: {
              id: requestId,
              nodeId: node.id,
              providerTurnId: this.turn.id,
              nativeRequestRef,
              kind: "user_input",
              status: "pending",
              // Box harnesses run headless, so the answer arrives as the next message.
              responseCapability: { type: "message" },
              createdAt: now,
              resolvedAt: null,
            },
          },
          {
            type: "turn_item.updated",
            driver: this.thread.driver,
            turnItem: {
              ...this.itemFields(nativeItemId, node.id, now),
              status: "waiting",
              completedAt: null,
              type: "user_input_request",
              requestId,
              questions: chunk.questions,
              responseMode: "message",
            },
          },
        ];
      }
    }
  }

  accept(chunk: BoxHarnessChunk, now: DateTime.Utc): ProviderAdapterV2Event[] {
    if (this.terminal) return [];
    switch (chunk.type) {
      case "todo":
      case "proposed-plan":
      case "question":
        return this.plan(chunk, now);
      case "reasoning": {
        if (!chunk.text) return [];
        const events = this.closeMessage(now);
        this.reasoning = this.reasoning
          ? { ...this.reasoning, text: this.reasoning.text + chunk.text, updatedAt: now }
          : {
              ...this.itemFields(
                `${this.input.attemptId}:reasoning:${this.reasoningIndex++}`,
                this.input.rootNodeId,
                now,
              ),
              status: "running",
              completedAt: null,
              type: "reasoning",
              text: chunk.text,
              streaming: true,
            };
        return [
          ...events,
          { type: "turn_item.updated", driver: this.thread.driver, turnItem: this.reasoning },
        ];
      }
      case "subagent-start":
      case "subagent-finish":
        return this.subagents.accept(chunk, now, () => ++this.itemOrdinal);
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
      case "text-delta": {
        const events = this.closeReasoning(now);
        this.hasText ||= chunk.text.length > 0;
        this.text += chunk.text;
        return [...events, ...this.messageEvents(now, true)];
      }
      case "tool-call": {
        const events = [...this.closeReasoning(now), ...this.closeMessage(now)];
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
    events.push(...this.subagents.settle(now), ...this.closeReasoning(now));
    if (this.todo?.status === "running") {
      this.todo = {
        ...this.todo,
        status: status === "completed" ? "completed" : status,
        completedAt: now,
        updatedAt: now,
      };
      events.push(...this.todoEvents(this.todo, now));
    }
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
