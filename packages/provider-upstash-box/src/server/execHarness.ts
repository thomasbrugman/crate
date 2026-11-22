import type { Chunk } from "@upstash/box";

import type { BoxHandle, BoxStream, BoxSubagentChunk } from "./BoxApi.ts";

function decodeFrame(frame: string): Chunk | BoxSubagentChunk | undefined {
  const match = /^event: (\w+)\r?\ndata: (.+)$/su.exec(frame);
  if (!match) return;
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(match[2]!);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    data = parsed as Record<string, unknown>;
  } catch {
    throw new Error("The harness returned an invalid stream frame.");
  }
  if (match[1] === "text" && typeof data.text === "string") {
    return { type: "text-delta", text: data.text };
  }
  if (typeof data.task_id === "string") {
    if (match[1] === "subagent_started") {
      return {
        type: "subagent-start",
        taskId: data.task_id,
        ...(typeof data.parent_task_id === "string" ? { parentTaskId: data.parent_task_id } : {}),
        title: typeof data.title === "string" ? data.title : "",
        prompt: typeof data.prompt === "string" ? data.prompt : "",
      };
    }
    if (
      match[1] === "subagent_finished" &&
      (data.status === "completed" || data.status === "failed" || data.status === "cancelled")
    ) {
      return {
        type: "subagent-finish",
        taskId: data.task_id,
        status: data.status,
        result: typeof data.result === "string" ? data.result : "",
      };
    }
  }
  const toolCallId = typeof data.tool_call_id === "string" ? data.tool_call_id : undefined;
  if (match[1] === "tool" && typeof data.name === "string") {
    return {
      type: "tool-call",
      toolName: data.name,
      ...(toolCallId === undefined ? {} : { toolCallId }),
      input:
        data.input && typeof data.input === "object" ? (data.input as Record<string, unknown>) : {},
    };
  }
  if (match[1] === "tool_result") {
    return {
      type: "tool-result",
      ...(toolCallId === undefined ? {} : { toolCallId }),
      output: data.output,
    };
  }
  if (match[1] === "done") {
    return {
      type: "finish",
      output: typeof data.output === "string" ? data.output : "",
      sessionId: typeof data.session_id === "string" ? data.session_id : "",
      usage: {
        inputTokens: typeof data.input_tokens === "number" ? data.input_tokens : 0,
        outputTokens: typeof data.output_tokens === "number" ? data.output_tokens : 0,
        cachedInputTokens: 0,
      },
    };
  }
  if (match[1] === "error") throw new Error("The harness could not complete the turn.");
}

export async function execHarness(box: BoxHandle, command: string): Promise<BoxStream> {
  if (!box.exec.stream) throw new Error("Box streaming execution is unavailable.");
  const run = await box.exec.stream(command);
  return {
    get id() {
      return run.id;
    },
    cancel: run.cancel,
    async *[Symbol.asyncIterator]() {
      let buffer = "";
      let finish: Extract<Chunk, { type: "finish" }> | undefined;
      let started = false;
      for await (const chunk of run) {
        if (!started) {
          started = true;
          yield { type: "start", runId: run.id };
        }
        if (chunk.type === "exit") {
          if (chunk.exitCode !== 0 || !finish?.sessionId)
            throw new Error("The harness could not complete the turn.");
          yield finish;
          return;
        }
        buffer += chunk.data;
        if (buffer.length > 8 * 1024 * 1024)
          throw new Error("The harness returned too much output.");
        for (
          let boundary = buffer.indexOf("\n\n");
          boundary >= 0;
          boundary = buffer.indexOf("\n\n")
        ) {
          const frame = decodeFrame(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (frame?.type === "finish") finish = frame;
          else if (frame !== undefined) yield frame;
        }
      }
      throw new Error("The Box stream ended without a turn result.");
    },
  };
}
