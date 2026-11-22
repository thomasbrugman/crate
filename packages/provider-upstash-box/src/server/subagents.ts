import type {
  NodeId,
  OrchestrationV2AppThread,
  OrchestrationV2ExecutionNode,
  OrchestrationV2Subagent,
} from "@t3tools/contracts";
import type { IdAllocatorV2Derive } from "@t3tools/provider-core/server/IdAllocator";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
  subagentThreadTitle,
} from "@t3tools/provider-core/server/subagentProjection";
import type * as DateTime from "effect/DateTime";

import type { BoxSubagentChunk } from "./BoxApi.ts";

interface Task {
  readonly child: OrchestrationV2AppThread;
  readonly node: OrchestrationV2ExecutionNode;
  readonly childRoot: NodeId;
  readonly ordinal: number;
  readonly nativeItemId: string;
  state: OrchestrationV2Subagent & {
    status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  };
}

export class BoxSubagents {
  private readonly tasks = new Map<string, Task>();
  private readonly input: ProviderAdapterV2TurnInput;
  private readonly ids: IdAllocatorV2Derive;

  constructor(input: ProviderAdapterV2TurnInput, ids: IdAllocatorV2Derive) {
    this.input = input;
    this.ids = ids;
  }

  accept(
    chunk: BoxSubagentChunk,
    now: DateTime.Utc,
    ordinal: () => number,
  ): ProviderAdapterV2Event[] {
    if (chunk.type === "subagent-finish") {
      const task = this.tasks.get(chunk.taskId);
      return task ? this.finish(task, chunk.status, chunk.result, now) : [];
    }
    if (this.tasks.has(chunk.taskId)) return [];
    const { input, ids } = this;
    const { driver, id: providerThreadId } = input.providerThread;
    const parent = chunk.parentTaskId ? this.tasks.get(chunk.parentTaskId) : undefined;
    const parentThread = parent?.child ?? input.appThread;
    const parentNodeId = parent?.childRoot ?? input.rootNodeId;
    const nativeItemId = `${providerThreadId}:task:${chunk.taskId}`;
    const nodeId = ids.nodeFromProviderItem({ driver, nativeItemId });
    const childRoot = ids.nodeFromProviderItem({ driver, nativeItemId: `${nativeItemId}:root` });
    const childThreadId = ids.subagentThread({ driver, nativeThreadId: nativeItemId });
    const title = subagentThreadTitle({
      parentTitle: parentThread.title,
      title: chunk.title,
      prompt: chunk.prompt,
      ordinal: this.tasks.size + 1,
    });
    const child = makeSubagentChildThread({
      parentThread,
      childThreadId,
      parentNodeId: nodeId,
      activeProviderThreadId: null,
      providerInstanceId: input.modelSelection.instanceId,
      modelSelection: input.modelSelection,
      title,
      now,
      createdBy: "agent",
      creationSource: "provider",
    });
    const nativeTaskRef = { driver, nativeId: chunk.taskId, strength: "strong" } as const;
    const task: Task = {
      child,
      childRoot,
      nativeItemId,
      ordinal: ordinal(),
      node: {
        id: nodeId,
        threadId: parentThread.id,
        runId: parent ? null : input.runId,
        parentNodeId,
        rootNodeId: parentNodeId,
        kind: "subagent",
        status: "running",
        countsForRun: false,
        providerThreadId: parent ? null : providerThreadId,
        providerTurnId: null,
        nativeItemRef: nativeTaskRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      },
      state: {
        id: nodeId,
        threadId: parentThread.id,
        runId: parent ? null : input.runId,
        parentNodeId,
        origin: "provider_native",
        createdBy: "agent",
        driver,
        providerInstanceId: input.modelSelection.instanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef,
        title,
        prompt: chunk.prompt,
        model: null,
        status: "running",
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      },
    };
    this.tasks.set(chunk.taskId, task);
    return [
      { type: "app_thread.created", driver, appThread: child, createOnly: true },
      ...this.lifecycle(task),
      ...this.conversation(task, "user", chunk.prompt, now),
    ];
  }

  settle(now: DateTime.Utc): ProviderAdapterV2Event[] {
    return [...this.tasks.values()].flatMap((task) => this.finish(task, "interrupted", "", now));
  }

  private finish(
    task: Task,
    status: "completed" | "failed" | "cancelled" | "interrupted",
    result: string,
    now: DateTime.Utc,
  ): ProviderAdapterV2Event[] {
    if (task.state.status !== "running") return [];
    task.state = {
      ...task.state,
      status,
      result: result || null,
      completedAt: now,
      updatedAt: now,
    };
    return [...this.lifecycle(task), ...this.conversation(task, "assistant", result, now)];
  }

  private lifecycle({
    child,
    childRoot,
    node,
    nativeItemId,
    ordinal,
    state,
  }: Task): ProviderAdapterV2Event[] {
    const { driver, status, completedAt, updatedAt } = state;
    return [
      { type: "node.updated", driver, node: { ...node, status, completedAt } },
      { type: "subagent.updated", driver, subagent: state },
      {
        type: "node.updated",
        driver,
        node: {
          ...node,
          status,
          completedAt,
          id: childRoot,
          kind: "root_turn",
          threadId: child.id,
          rootNodeId: childRoot,
          parentNodeId: null,
          runId: null,
          providerThreadId: null,
        },
      },
      {
        type: "turn_item.updated",
        driver,
        turnItem: {
          id: this.ids.turnItemFromProviderItem({ driver, nativeItemId }),
          threadId: state.threadId,
          runId: state.runId,
          nodeId: node.id,
          providerThreadId: node.providerThreadId,
          providerTurnId: null,
          nativeItemRef: state.nativeTaskRef,
          parentItemId: null,
          ordinal,
          status,
          title: state.title,
          startedAt: state.startedAt,
          completedAt,
          updatedAt,
          type: "subagent",
          subagentId: node.id,
          origin: "provider_native",
          driver,
          providerInstanceId: state.providerInstanceId,
          childThreadId: child.id,
          prompt: state.prompt,
          result: state.result,
        },
      },
    ];
  }

  private conversation(
    task: Task,
    role: "user" | "assistant",
    text: string,
    now: DateTime.Utc,
  ): ProviderAdapterV2Event[] {
    if (!text) return [];
    const { driver } = task.state;
    const nativeItemId = `${task.nativeItemId}:${role}`;
    const { message, turnItem } = makeSubagentConversationArtifacts({
      messageId: this.ids.messageFromProviderItem({ driver, nativeItemId }),
      turnItemId: this.ids.turnItemFromProviderItem({ driver, nativeItemId }),
      senderThreadId: task.state.threadId,
      threadId: task.child.id,
      rootNodeId: task.childRoot,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      role,
      text,
      ordinal: role === "user" ? 0 : 1,
      now,
    });
    return [
      { type: "message.updated", driver, message },
      { type: "turn_item.updated", driver, turnItem },
    ];
  }
}
