// @effect-diagnostics globalFetch:off -- The SDK stdout relay owns the native AbortSignal and has no Effect HTTP runtime.
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";

import { BOX_HARNESS_DRIVER_KINDS, type BoxHarness } from "../harnesses.ts";

const protocolVersion = "2025-06-18";
const clientInfo = { name: "t3stash-box", version: "1.0.0" };
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function makeDelegationMcp(
  config: Pick<McpProviderSessionConfig, "endpoint" | "authorizationHeader">,
  harnesses: ReadonlyArray<BoxHarness>,
  signal: AbortSignal,
) {
  const headers = {
    accept: "application/json, text/event-stream",
    authorization: config.authorizationHeader,
    "content-type": "application/json",
    "mcp-protocol-version": protocolVersion,
  };
  let sessionId: string | null = null;
  let initialization: Promise<void> | undefined;
  const send = (method: string, params: unknown, id?: number) =>
    fetch(config.endpoint, {
      method: "POST",
      redirect: "error",
      signal,
      headers: sessionId ? { ...headers, "mcp-session-id": sessionId } : headers,
      body: JSON.stringify({ jsonrpc: "2.0", method, id, params }),
    });
  const initialize = async () => {
    const response = await send("initialize", { protocolVersion, capabilities: {}, clientInfo }, 0);
    sessionId = response.headers.get("mcp-session-id");
    await response.body?.cancel();
    if (!response.ok || !sessionId) throw new Error("Could not open Box delegation.");
    const initialized = await send("notifications/initialized", {});
    await initialized.body?.cancel();
    if (!initialized.ok) throw new Error("Could not open Box delegation.");
  };
  let nextId = 1;
  const call = async (name: string, args: object) => {
    await (initialization ??= initialize());
    const id = nextId++;
    const response = await send("tools/call", { name, arguments: args }, id);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Box delegation call failed.");
    }
    const body = await response.text();
    const reply = response.headers.get("content-type")?.includes("text/event-stream")
      ? body
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => object(JSON.parse(line.slice(6))))
          .find((message) => message.id === id)
      : object(JSON.parse(body));
    if (reply?.id !== id || reply.result === undefined)
      throw new Error("Box delegation call failed.");
    return reply.result;
  };
  const taskId = { type: "string", description: "Task ID returned by delegate_task." };
  const text = { type: "string" };
  const tool = (name: string, description: string, properties: object, required: string[]) => ({
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
  });
  const tools = [
    tool(
      "delegate_task",
      "Start a connected harness in a linked T3 child thread in this Box, in its own Git worktree at the parent checkout's committed HEAD. Commit any changes the child must see first. Give only the task, never secrets. Async by default: completion wakes this thread.",
      {
        harness: { type: "string", enum: harnesses },
        task: text,
        title: text,
        model: text,
        mode: { type: "string", enum: ["async", "wait"] },
        clientRequestId: text,
      },
      ["harness", "task"],
    ),
    tool("task_status", "Read the status and result of a delegated task.", { taskId }, ["taskId"]),
    tool("task_cancel", "Cancel a delegated task from this thread.", { taskId }, ["taskId"]),
  ];
  return {
    async handle(input: unknown): Promise<object | undefined> {
      const { id, method, params } = object(input);
      if (typeof id !== "number" && typeof id !== "string") return;
      const message = { jsonrpc: "2.0", id };
      const result = (value: object) => ({ ...message, result: value });
      const error = (code: number, messageText: string) => ({
        ...message,
        error: { code, message: messageText },
      });
      const toolError = (text: string) =>
        result({ isError: true, content: [{ type: "text", text }] });
      if (method === "initialize")
        return result({ protocolVersion, capabilities: { tools: {} }, serverInfo: clientInfo });
      if (method === "ping") return result({});
      if (method === "tools/list") return result({ tools });
      if (method !== "tools/call") return error(-32601, "Method not found.");
      const { name, arguments: raw } = object(params);
      const args = object(raw);
      try {
        if (name === "delegate_task") {
          const harness = harnesses.find((candidate) => candidate === args.harness);
          if (!harness || typeof args.task !== "string")
            return toolError("Pass a task and a connected Box harness.");
          return {
            ...message,
            result: await call(name, {
              task: args.task,
              target: {
                driverKind: BOX_HARNESS_DRIVER_KINDS[harness],
                ...(typeof args.model === "string" ? { model: args.model } : {}),
              },
              isolation: "worktree",
              ...(typeof args.title === "string" ? { title: args.title } : {}),
              ...(args.mode === "wait" ? { mode: "wait" } : {}),
              ...(typeof args.clientRequestId === "string"
                ? { clientRequestId: args.clientRequestId }
                : {}),
            }),
          };
        }
        if (name === "task_status" || name === "task_cancel") {
          if (typeof args.taskId !== "string") return toolError("Pass a delegated task ID.");
          return { ...message, result: await call(name, { taskId: args.taskId }) };
        }
        return toolError("This tool is not available in the Box.");
      } catch {
        return toolError("The T3 delegation service could not complete this call.");
      }
    },
    async close() {
      if (sessionId === null) return;
      try {
        const response = await fetch(config.endpoint, {
          method: "DELETE",
          redirect: "error",
          signal: AbortSignal.timeout(3000),
          headers: { ...headers, "mcp-session-id": sessionId },
        });
        await response.body?.cancel();
      } catch {
        // The turn is already closed; the server can expire its orphaned MCP session.
      }
    },
  };
}
