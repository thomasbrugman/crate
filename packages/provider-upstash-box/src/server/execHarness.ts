// @effect-diagnostics nodeBuiltinImport:off -- Turn the Box SDK's synchronous stdout callbacks into an async iterable.
import * as NodeStream from "node:stream";
import type { Chunk, ExecStreamChunk } from "@upstash/box";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";

import type { BoxHandle, BoxStream, BoxSubagentChunk } from "./BoxApi.ts";
import { makeMcpRelay } from "./mcpRelay.ts";

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

async function duplexHarness(box: BoxHandle, command: string, config: McpProviderSessionConfig) {
  if (!box.exec.session) throw new Error("Box interactive execution is unavailable.");
  const output = new NodeStream.Readable({ read() {} });
  output.setEncoding("utf8");
  const session = await box.exec.session({
    cmd: command,
    onStdout: (data) => output.push(data),
  });
  const exited = session.wait().then(
    (code) => {
      output.push(null);
      return code;
    },
    () => {
      output.destroy();
      return -1;
    },
  );
  const mcp = makeMcpRelay(config);
  let closed = false;
  const cancel = async () => {
    if (closed) return;
    closed = true;
    output.destroy();
    session.close();
    await mcp.close();
  };
  return {
    id: session.id,
    cancel,
    onFrame(frame: string) {
      const match = /^event: (mcp_request|mcp_disconnect)\ndata: (.+)$/su.exec(frame);
      if (!match) return false;
      const { client, request } = JSON.parse(match[2]!) as {
        readonly client: number;
        readonly request?: unknown;
      };
      if (!Number.isSafeInteger(client) || client <= 0) return true;
      if (match[1] === "mcp_disconnect") {
        void mcp.disconnect(client);
        return true;
      }
      const reply = (response: object) => {
        if (!closed) {
          try {
            session.write(JSON.stringify({ client, response }) + "\n");
          } catch {
            // The Box can exit before a tool call replies.
          }
        }
      };
      void mcp.handle(client, request, reply).then((response) => {
        if (response !== undefined) reply(response);
      });
      return true;
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<ExecStreamChunk> {
      try {
        for await (const data of output as AsyncIterable<string>) yield { type: "output", data };
        yield { type: "exit", exitCode: await exited, cpuNs: 0 };
      } finally {
        await cancel();
      }
    },
  };
}

export async function execHarness(
  box: BoxHandle,
  command: string,
  mcpSession?: McpProviderSessionConfig,
): Promise<BoxStream> {
  const duplex = mcpSession && (await duplexHarness(box, command, mcpSession));
  const run = duplex ?? (await box.exec.stream?.(command));
  if (!run) throw new Error("Box streaming execution is unavailable.");
  return {
    get id() {
      return run.id;
    },
    cancel: run.cancel,
    ...(mcpSession === undefined ? {} : { ownsProcess: true }),
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
          const payload = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (duplex?.onFrame(payload)) continue;
          const frame = decodeFrame(payload);
          if (frame?.type === "finish") finish = frame;
          else if (frame !== undefined) yield frame;
        }
      }
      throw new Error("The Box stream ended without a turn result.");
    },
  };
}
