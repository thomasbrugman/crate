// @effect-diagnostics globalFetch:off -- The Box SDK relay owns the native AbortSignal.
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import { discardResponseBody, responsePayloads } from "@t3tools/shared/mcpResponsePayloads";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

const protocolVersion = "2025-06-18";
const errorReply = (id: string | number, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

const readReply = async (
  response: Response,
  id: string | number,
  signal: AbortSignal,
  notify?: (message: object) => void,
) => {
  const failure = new Error("MCP request failed.");
  if (!response.ok) {
    await Effect.runPromise(discardResponseBody(response), { signal });
    throw failure;
  }
  const reply = await Effect.runPromise(
    responsePayloads(response, () => failure).pipe(
      Stream.filter(Predicate.isReadonlyObject),
      Stream.tap((message) =>
        Effect.sync(() => {
          if (message.id === undefined && typeof message.method === "string") notify?.(message);
        }),
      ),
      Stream.filter((message) => message.id === id),
      Stream.runHead,
    ),
    { signal },
  );
  if (Option.isNone(reply)) throw failure;
  return reply.value;
};

export function makeMcpRelay(
  config: Pick<McpProviderSessionConfig, "endpoint" | "authorizationHeader">,
) {
  const clients = new Map<number, ReturnType<typeof openClient>>();
  let closed = false;
  let inFlight = 0;
  const baseHeaders = {
    accept: "application/json, text/event-stream",
    authorization: config.authorizationHeader,
    "content-type": "application/json",
  };
  function openClient() {
    const abort = new AbortController();
    let sessionId: string | null = null;
    const headers = () =>
      sessionId === null
        ? baseHeaders
        : { ...baseHeaders, "mcp-session-id": sessionId, "mcp-protocol-version": protocolVersion };
    const send = (body: unknown, signal = abort.signal) =>
      fetch(config.endpoint, {
        method: "POST",
        redirect: "error",
        signal,
        headers: headers(),
        body: JSON.stringify(body),
      });
    let ready: Promise<Record<PropertyKey, unknown>> | undefined;
    return {
      initialize(id: string | number, clientInfo: unknown) {
        ready ??= (async () => {
          const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]);
          const response = await send(
            {
              jsonrpc: "2.0",
              id,
              method: "initialize",
              params: { protocolVersion, capabilities: {}, clientInfo },
            },
            signal,
          );
          sessionId = response.headers.get("mcp-session-id");
          const reply = await readReply(response, id, signal);
          if (sessionId === null || reply.result === undefined)
            throw new Error("MCP session failed.");
          const initialized = await send(
            { jsonrpc: "2.0", method: "notifications/initialized" },
            signal,
          );
          await initialized.body?.cancel();
          if (!initialized.ok) throw new Error("MCP session failed.");
          return reply;
        })();
        return ready.then((reply) => ({ ...reply, id }));
      },
      async request(
        id: string | number,
        method: string,
        params: unknown,
        notify: (message: object) => void,
      ) {
        if (!ready) return errorReply(id, -32002, "MCP session is not initialized.");
        await ready;
        return readReply(
          await send({ jsonrpc: "2.0", id, method, params }),
          id,
          abort.signal,
          notify,
        );
      },
      async cancel(params: unknown) {
        if (!ready) return;
        await ready;
        const response = await send({ jsonrpc: "2.0", method: "notifications/cancelled", params });
        await response.body?.cancel();
      },
      async close() {
        abort.abort();
        if (sessionId === null) return;
        try {
          const response = await fetch(config.endpoint, {
            method: "DELETE",
            redirect: "error",
            signal: AbortSignal.timeout(3000),
            headers: headers(),
          });
          await response.body?.cancel();
        } catch {
          // The server can expire an orphaned MCP session.
        }
      },
    };
  }
  return {
    async handle(
      clientId: number,
      input: unknown,
      notify: (message: object) => void,
    ): Promise<object | undefined> {
      if (closed || !Predicate.isReadonlyObject(input) || input.jsonrpc !== "2.0") return;
      const { id, method, params } = input;
      if (method === "notifications/cancelled" && id === undefined) {
        await clients
          .get(clientId)
          ?.cancel(params)
          .catch(() => {});
        return;
      }
      if (typeof id !== "number" && typeof id !== "string") return;
      if (typeof method !== "string") return errorReply(id, -32600, "Invalid MCP request.");
      if (inFlight >= 16) return errorReply(id, -32603, "Box MCP relay is at capacity.");
      let client = clients.get(clientId);
      if (!client) {
        if (method !== "initialize")
          return errorReply(id, -32002, "MCP session is not initialized.");
        if (clients.size >= 8) return errorReply(id, -32603, "Box MCP relay is at capacity.");
        client = openClient();
        clients.set(clientId, client);
      }
      inFlight++;
      try {
        return method === "initialize"
          ? await client.initialize(
              id,
              Predicate.isReadonlyObject(params)
                ? params.clientInfo
                : { name: "crate-box", version: "1" },
            )
          : await client.request(id, method, params, notify);
      } catch {
        return errorReply(id, -32603, "The T3 MCP server could not complete this request.");
      } finally {
        inFlight--;
      }
    },
    async disconnect(clientId: number) {
      const client = clients.get(clientId);
      clients.delete(clientId);
      await client?.close();
    },
    async close() {
      if (closed) return;
      closed = true;
      const open = [...clients.values()];
      clients.clear();
      await Promise.all(open.map((client) => client.close()));
    },
  };
}
