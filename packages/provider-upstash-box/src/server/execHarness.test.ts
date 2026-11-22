// @effect-diagnostics nodeBuiltinImport:off -- A subprocess fixture exercises the Box SDK's native callback interface.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { ExecStreamChunk } from "@upstash/box";
import { expect, it, vi } from "vite-plus/test";

import type { BoxHandle } from "./BoxApi.ts";
import { BOX_CREDENTIALS_DIR } from "./credentials.ts";
import { execHarness } from "./execHarness.ts";
import { commandCodeHarness } from "./harness.ts";
import { managedHarness } from "./managedHarness.ts";

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

const cliFixture = String.raw`#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
const bin = basename(process.argv[1], '.mjs');
const args = process.argv.slice(2);
let server;
if (bin === 'command-code') {
  server = JSON.parse(readFileSync(process.env.HOME + '/.commandcode/mcp.json')).mcpServers['t3-code'];
} else if (bin === 'claude') {
  server = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers['t3-code'];
} else {
  const config = key => JSON.parse(args.find(arg => arg.startsWith('mcp_servers.t3-code.' + key + '=')).split('=')[1]);
  server = { command: config('command'), args: config('args') };
}
const child = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'inherit'] });
const exited = once(child, 'exit');
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
const send = (method, params, id) => child.stdin.write(
  JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
);
const read = async () => JSON.parse((await lines.next()).value);
send('initialize', { clientInfo: { name: bin, version: '1' } }, 1);
if (!(await read()).result?.capabilities?.tools) process.exit(1);
send('notifications/initialized', {});
send('tools/list', {}, 2);
if (!(await read()).result?.tools.some(tool => tool.name === 't3_thread_list')) process.exit(1);
send('tools/call', {
  name: 'delegate_task', arguments: { target: { driverKind: 'boxCodex' }, task: 'Review\u2028my changes.' },
}, 3);
if ((await read()).method !== 'notifications/progress') process.exit(1);
if ((await read()).result?.structuredContent?.taskId !== 'visible-linked-task') process.exit(1);
send('notifications/cancelled', { requestId: 3 });
child.stdin.end();
await exited;
const frames = bin === 'command-code'
  ? [{ type: 'result', sessionId: 'fixture-session' }]
  : bin === 'claude'
    ? [{ type: 'result', subtype: 'success', session_id: 'fixture-session' }]
    : [{ type: 'thread.started', thread_id: 'fixture-session' }, { type: 'turn.completed' }];
for (const frame of frames) process.stdout.write(JSON.stringify(frame) + '\n');
`;

it.each([
  { harness: "commandCode", binary: "command-code" },
  { harness: "claudeCode", binary: "claude" },
  { harness: "codex", binary: "codex" },
])(
  "relays MCP listing and calls through the $harness CLI config without the bearer",
  async (test) => {
    await using dir = await NodeFSP.mkdtempDisposable(
      NodePath.join(NodeOS.tmpdir(), "t3-box-mcp-"),
    );
    await NodeFSP.mkdir(NodePath.join(dir.path, "command-home/.commandcode"), { recursive: true });
    const wrapper = NodePath.join(dir.path, "wrapper.mjs");
    const commandCode = test.harness === "commandCode";
    await NodeFSP.writeFile(
      wrapper,
      (commandCode ? commandCodeHarness : managedHarness).replaceAll(BOX_CREDENTIALS_DIR, dir.path),
    );
    const bin = NodePath.join(dir.path, test.binary);
    await NodeFSP.writeFile(bin + ".mjs", cliFixture, { mode: 0o755 });
    await NodeFSP.symlink(bin + ".mjs", bin);
    const endpoint = "http://localhost/mcp";
    const requests: unknown[] = [];
    const closedSessions: Array<string | null> = [];
    using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
      expect(url).toBe(endpoint);
      const headers = new Headers(options?.headers);
      expect(headers.get("authorization")).toBe("Bearer host-only");
      if (options?.method === "DELETE") {
        closedSessions.push(headers.get("mcp-session-id"));
        return new Response(null, { status: 204 });
      }
      const request = JSON.parse(String(options?.body));
      if (request.method === "initialize") {
        return Response.json(
          { jsonrpc: "2.0", id: request.id, result: { capabilities: { tools: {} } } },
          { headers: { "mcp-session-id": "host-session" } },
        );
      }
      expect(headers.get("mcp-session-id")).toBe("host-session");
      if (request.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      requests.push({ method: request.method, params: request.params });
      if (request.method === "notifications/cancelled") return new Response(null, { status: 202 });
      const result =
        request.method === "tools/list"
          ? { tools: [{ name: "delegate_task" }, { name: "t3_thread_list" }] }
          : { structuredContent: { taskId: "visible-linked-task", status: "running" } };
      return new Response(
        (request.method === "tools/call"
          ? 'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":3,"progress":1}}\r\n\r\n'
          : "") +
          "event: message\r\ndata: " +
          JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) +
          "\r\n\r\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const box = fakeBox([], 0);
    const sent: Array<string | Uint8Array> = [];
    const args = commandCode
      ? [wrapper, "-p", "fixture", "--explicit-session", "--t3-mcp-relay"]
      : [wrapper, test.harness, "fixture", "model", "", "file", "relay"];
    const stream = await execHarness(
      {
        ...box,
        exec: {
          ...box.exec,
          session: async ({ onStdout, cmd }) => {
            expect(cmd).not.toContain("host-only");
            const child = NodeChildProcess.spawn(process.execPath, args, {
              cwd: dir.path,
              env: {
                ...process.env,
                PATH: [dir.path, NodePath.dirname(process.execPath), process.env.PATH].join(
                  NodePath.delimiter,
                ),
                BOXJOB_CC_BIN: bin,
              },
              stdio: ["pipe", "pipe", "inherit"],
            });
            const exited = new Promise<number>((resolve, reject) => {
              child.once("error", reject);
              child.once("close", (code) => resolve(code ?? -1));
            });
            child.stdout.on("data", (data: Uint8Array) => onStdout?.(data));
            child.stdin.on("error", () => {});
            return {
              id: "run",
              pid: child.pid!,
              resize: () => {},
              close: () => {
                child.kill();
              },
              wait: () => exited,
              write: (answer) => {
                sent.push(answer);
                child.stdin.write(answer);
              },
            };
          },
        },
      },
      "fixture",
      {
        endpoint,
        authorizationHeader: "Bearer host-only",
        threadId: ThreadId.make("parent"),
        environmentId: EnvironmentId.make("local"),
        providerInstanceId: ProviderInstanceId.make("boxClaudeCode"),
        providerSessionId: "parent-session",
        browserToolsAvailable: false,
      },
    );
    expect(await Array.fromAsync(stream)).toMatchObject([
      { type: "start" },
      { type: "finish", sessionId: "fixture-session" },
    ]);
    expect(requests).toEqual([
      {
        method: "tools/list",
        params: {},
      },
      {
        method: "tools/call",
        params: {
          name: "delegate_task",
          arguments: { target: { driverKind: "boxCodex" }, task: "Review\u2028my changes." },
        },
      },
      { method: "notifications/cancelled", params: { requestId: 3 } },
    ]);
    const answers = sent.join("\n");
    expect(answers).toContain("visible-linked-task");
    expect(answers).toContain("t3_thread_list");
    expect(answers).not.toContain("host-only");
    expect(closedSessions).toEqual(["host-session"]);
  },
);
