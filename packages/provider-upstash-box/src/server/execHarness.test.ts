import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { ExecStreamChunk } from "@upstash/box";
import { expect, it, vi } from "vite-plus/test";

import type { BoxHandle } from "./BoxApi.ts";
import { execHarness } from "./execHarness.ts";

function fakeBox(pieces: ReadonlyArray<string>, exitCode: number): BoxHandle {
  return {
    id: "box",
    exec: {
      command: async () => ({ stdout: "", exitCode: 0 }),
      stream: async () => ({
        id: "run",
        cancel: async () => undefined,
        async *[Symbol.asyncIterator](): AsyncGenerator<ExecStreamChunk> {
          for (const data of pieces) yield { type: "output", data };
          yield { type: "exit", exitCode, cpuNs: 0 };
        },
      }),
    },
    agent: {
      stream: async () => {
        throw new Error("must not use the native agent");
      },
    },
    files: { write: async () => undefined },
    delete: async () => undefined,
    resume: async () => undefined,
    getStatus: async () => ({ status: "idle" }),
  };
}

it("restores fragmented harness frames and commits the session only after a successful exit", async () => {
  const done = 'event: done\ndata: {"session_id":"provider-session"}\n\n';
  const output = ['event: text\ndata: {"text":"test"}\n', "\n" + done];
  const successful = await execHarness(fakeBox(output, 0), "fixture");
  const failed = await execHarness(fakeBox(output, 1), "fixture");
  expect(await Array.fromAsync(successful)).toMatchObject([
    { type: "start", runId: "run" },
    { type: "text-delta", text: "test" },
    { type: "finish", sessionId: "provider-session" },
  ]);
  await expect(Array.fromAsync(failed)).rejects.toThrow("The harness could not complete the turn.");
});

it("does not expose a malformed frame as an error message", async () => {
  const stream = await execHarness(
    fakeBox(["event: text\ndata: private fixture\n\n"], 0),
    "fixture",
  );
  await expect(Array.fromAsync(stream)).rejects.toThrow(
    "The harness returned an invalid stream frame.",
  );
});

it("relays only same-Box task tools without returning the host credential", async () => {
  const endpoint = "http://localhost/mcp";
  const requests: unknown[] = [];
  using fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    expect(url).toBe(endpoint);
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer host-only");
    if (options?.method === "DELETE") return new Response(null, { status: 204 });
    const request = JSON.parse(String(options?.body));
    if (request.method === "initialize") {
      return new Response("{}", { headers: { "mcp-session-id": "host-session" } });
    }
    expect(new Headers(options?.headers).get("mcp-session-id")).toBe("host-session");
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    requests.push(request.params);
    return Response.json({
      id: request.id,
      result: { structuredContent: { taskId: "visible-linked-task", status: "running" } },
    });
  });
  const box = fakeBox([], 0);
  const sent: string[] = [];
  const boot = Promise.withResolvers<number>();
  const stream = await execHarness(
    {
      ...box,
      exec: {
        ...box.exec,
        session: async ({ onStdout, cmd }) => {
          expect(cmd).not.toContain("host-only");
          const send = (data: string) => onStdout?.(new TextEncoder().encode(data));
          const request = (id: number, name: string, args: object) =>
            `event: delegation\ndata: ${JSON.stringify({
              id,
              request: {
                jsonrpc: "2.0",
                id,
                method: "tools/call",
                params: { name, arguments: args },
              },
            })}\n\n`;
          send(
            request(1, "request_secret", {}) +
              request(2, "delegate_task", { harness: "commandCode", task: "Not connected" }) +
              request(3, "delegate_task", {
                harness: "codex",
                model: "gpt-5.5",
                task: "Review my committed changes",
                target: { environmentId: "outside" },
                isolation: "shared",
              }),
          );
          return {
            id: "run",
            close: () => boot.resolve(-1),
            wait: () => boot.promise,
            write: (answer) => {
              sent.push(answer);
              if (sent.length === 3) {
                send('event: done\ndata: {"session_id":"claude-session"}\n\n');
                boot.resolve(0);
              }
            },
          };
        },
      },
    },
    "fixture",
    {
      config: {
        endpoint,
        authorizationHeader: "Bearer host-only",
        threadId: ThreadId.make("parent"),
        environmentId: EnvironmentId.make("local"),
        providerInstanceId: ProviderInstanceId.make("boxClaudeCode"),
        providerSessionId: "parent-session",
        browserToolsAvailable: false,
      },
      harnesses: ["claudeCode", "codex"],
    },
  );
  expect(await Array.fromAsync(stream)).toMatchObject([
    { type: "start" },
    { type: "finish", sessionId: "claude-session" },
  ]);
  expect(requests).toEqual([
    {
      name: "delegate_task",
      arguments: {
        target: { driverKind: "boxCodex", model: "gpt-5.5" },
        task: "Review my committed changes",
        isolation: "worktree",
      },
    },
  ]);
  const answers = sent.join("\n");
  expect(answers).toContain("visible-linked-task");
  expect(answers).toContain("connected Box harness");
  expect(answers).toContain("not available in the Box");
  expect(answers).not.toContain("host-only");
  expect(fetch).toHaveBeenCalledTimes(4);
});
