import {
  Agent,
  Box,
  BoxApiKey,
  BoxError,
  type BoxConfig,
  type Chunk,
  type ExecStreamChunk,
  type ExecSessionOptions,
  type ClaudeCode,
  type OpenAICodex,
  type StreamOptions,
} from "@upstash/box";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { BoxHarness } from "../harnesses.ts";

export type ManagedAgentHarness = Exclude<BoxHarness, "commandCode">;
import { COMMAND_CODE_TEMPLATE_MODEL } from "./models.ts";

export const BOX_HOME = "/home/boxuser";
export const BOX_WORKSPACE_PATH = "/workspace/home";
export const BOX_REPOSITORY_PATH = "/workspace/home/repo";
export const BOX_WORKTREES_PATH = `${BOX_WORKSPACE_PATH}/.t3stash-worktrees`;

export const boxWorktreePath = (threadId: string) =>
  `${BOX_WORKTREES_PATH}/${Buffer.from(threadId).toString("hex")}`;

export const BoxErrorDetails = Schema.Struct({
  message: Schema.String,
  statusCode: Schema.optional(Schema.Number),
  boxId: Schema.optional(Schema.String),
});

export function boxErrorDetails(
  error: unknown,
  options: { readonly boxId?: string } = {},
): typeof BoxErrorDetails.Type {
  const statusCode =
    error instanceof Error &&
    "statusCode" in error &&
    typeof error.statusCode === "number" &&
    Number.isInteger(error.statusCode) &&
    error.statusCode >= 100 &&
    error.statusCode <= 599
      ? error.statusCode
      : undefined;
  return {
    message: "Upstash Box request failed.",
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(options.boxId === undefined ? {} : { boxId: options.boxId }),
  };
}

export class BoxRuntimeError extends Schema.TaggedError<BoxRuntimeError>()("BoxRuntimeError", {
  operation: Schema.String,
  statusCode: Schema.optional(Schema.Number),
  /** Box creation was refused because the account has no stored key for the agent's model. */
  missingStoredKey: Schema.optional(Schema.Boolean),
}) {}

export function isMissingStoredKey(error: unknown): boolean {
  return (
    error instanceof BoxError &&
    error.statusCode === 400 &&
    /stored agent api key is not configured/i.test(error.message)
  );
}

export type BoxSubagentChunk =
  | {
      readonly type: "subagent-start";
      readonly taskId: string;
      readonly parentTaskId?: string;
      readonly title: string;
      readonly prompt: string;
    }
  | {
      readonly type: "subagent-finish";
      readonly taskId: string;
      readonly status: "completed" | "failed" | "cancelled";
      readonly result: string;
    };

export interface BoxStream extends AsyncIterable<Chunk | BoxSubagentChunk> {
  readonly id: string;
  readonly cancel: () => Promise<void>;
  readonly ownsProcess?: true;
}

export interface BoxHandle {
  readonly id: string;
  readonly agent: { readonly stream: (options: StreamOptions) => Promise<BoxStream> };
  readonly exec: {
    readonly stream?: (command: string) => Promise<
      {
        readonly id: string;
        readonly cancel: () => Promise<void>;
      } & AsyncIterable<ExecStreamChunk>
    >;
    readonly command: (command: string) => Promise<{
      readonly stdout: string;
      readonly stderr?: string;
      readonly exitCode: number | null;
    }>;
    readonly session?: (options: Pick<ExecSessionOptions, "cmd" | "onStdout">) => Promise<{
      readonly id: string;
      readonly write: (data: string) => void;
      readonly wait: () => Promise<number>;
      readonly close: () => void;
    }>;
  };
  readonly files: {
    readonly write: (options: { path: string; content: string }) => Promise<unknown>;
    readonly writeVolatile?: (path: string, content: string) => Promise<void>;
  };
  readonly delete: () => Promise<unknown>;
  readonly resume: () => Promise<void>;
  readonly getStatus: () => Promise<{ readonly status: string }>;
  /** Password-protected public URLs. Credentials come back only when a URL is created. */
  readonly publicUrls?: {
    readonly create: (port: number) => Promise<BoxPublicUrl>;
    readonly list: () => Promise<ReadonlyArray<{ readonly port: number }>>;
    readonly delete: (port: number) => Promise<void>;
  };
  /** Runs on every container start: create, resume, and snapshot restore. */
  readonly initCommand?: {
    readonly get: () => Promise<string>;
    readonly set: (command: string) => Promise<void>;
  };
}

export interface BoxPublicUrl {
  readonly url: string;
  readonly username: string;
  readonly password: string;
}

export const quoteShell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export async function requireCommand(box: Pick<BoxHandle, "exec">, command: string): Promise<void> {
  if ((await box.exec.command(command)).exitCode !== 0)
    throw new Error("Box setup command failed.");
}

export class BoxApi extends Context.Service<
  BoxApi,
  {
    readonly get: (id: string, apiKey: string) => Promise<BoxHandle>;
    readonly create: (config: BoxConfig) => Promise<BoxHandle>;
    readonly restore?: (snapshotId: string, config: BoxConfig) => Promise<BoxHandle>;
    readonly list: (apiKey: string) => Promise<unknown>;
    /** The HTTP status the model provider answers a cheap authenticated request with. */
    readonly checkModelKey: (harness: ManagedAgentHarness, apiKey: string) => Promise<number>;
  }
>()("@t3tools/provider-upstash-box/server/BoxApi") {}

function projectBox(box: Box): BoxHandle {
  return {
    id: box.id,
    agent: {
      stream: async (options) => {
        const stream = await box.agent.stream(options);
        return {
          get id() {
            return stream.id;
          },
          cancel: async () => {
            await stream.cancel();
          },
          async *[Symbol.asyncIterator]() {
            yield* stream;
          },
        };
      },
    },
    exec: {
      session: async (options) => {
        const session = await box.exec.session(options);
        return {
          id: session.execId,
          write: (data) => session.write(data),
          wait: () => session.wait(),
          close: () => session.close(),
        };
      },
      stream: async (command) => {
        const run = await box.exec.stream(command);
        return {
          get id() {
            return run.id;
          },
          cancel: async () => {
            await run.cancel();
          },
          async *[Symbol.asyncIterator]() {
            yield* run;
          },
        };
      },
      command: async (command) => {
        const result = await box.exec.command(command);
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      },
    },
    files: {
      write: async (options) => {
        await box.files.write(options);
      },
      writeVolatile: async (path, content) => {
        // The files API does not reach tmpfs. Send the bytes over live stdin, not argv or stdout.
        const session = await box.exec.session({
          argv: [
            "sh",
            "-c",
            [
              'set -eu; umask 077; directory=$(dirname -- "$1")',
              'test "$(stat -f -c %T "$directory")" = tmpfs',
              'temp=$(mktemp "$directory/.t3-auth.XXXXXXXX")',
              "trap 'rm -f -- \"$temp\"' EXIT",
              'cat > "$temp"; mv -fT -- "$temp" "$1"',
            ].join("; "),
            "sh",
            path,
          ],
        });
        try {
          session.write(content);
          session.endStdin();
          if ((await session.wait()) !== 0) throw new Error("Box credential write failed.");
        } finally {
          session.close();
        }
      },
    },
    delete: async () => {
      await box.delete();
    },
    resume: async () => {
      await box.resume();
    },
    getStatus: async () => ({ status: (await box.getStatus()).status }),
    publicUrls: {
      create: async (port) => {
        const created = await box.getPublicURL(port, { basicAuth: true });
        if (!created.username || !created.password)
          throw new Error("Box public URL has no credentials.");
        return { url: created.url, username: created.username, password: created.password };
      },
      list: async () =>
        (await box.listPublicURLs()).publicURLs.map((entry) => ({ port: entry.port })),
      delete: async (port) => {
        await box.deletePublicURL(port);
      },
    },
    initCommand: {
      get: () => box.getInitCommand(),
      set: (command) => box.setInitCommand(command),
    },
  };
}

export const layer = Layer.succeed(BoxApi, {
  get: async (id, apiKey) => projectBox(await Box.get(id, { apiKey })),
  create: async (config) => projectBox(await Box.create(config)),
  restore: async (snapshotId, config) => projectBox(await Box.fromSnapshot(snapshotId, config)),
  list: async (apiKey) => {
    await Box.list({ apiKey });
  },
  checkModelKey: async (harness, apiKey) => {
    // @effect-diagnostics-next-line globalFetch:off - This service is the Promise boundary the Box SDK already uses.
    const response = await fetch(
      harness === "claudeCode"
        ? "https://api.anthropic.com/v1/models?limit=1"
        : "https://api.openai.com/v1/models",
      {
        headers:
          harness === "claudeCode"
            ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
            : { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    return response.status;
  },
});

export function isMissingBox(error: unknown): boolean {
  return error instanceof BoxError && error.statusCode === 404;
}

export function boxConfig(input: {
  apiKey: string;
  name: string;
  size: BoxConfig["size"];
  harness: BoxHarness;
  model: string;
  agentApiKey: string;
  repositoryUrl?: string;
}): BoxConfig {
  const base = {
    apiKey: input.apiKey,
    name: input.name,
    runtime: "node",
    size: input.size ?? "small",
    keepAlive: false,
    labels: ["t3stash"],
    networkPolicy: { mode: "allow-all" },
  } satisfies BoxConfig;
  if (input.harness === "commandCode")
    return {
      ...base,
      env: {
        BOXJOB_CC_BIN: "/home/boxuser/.local/bin/command-code",
        BOXJOB_CC_CWD: input.repositoryUrl ? BOX_REPOSITORY_PATH : BOX_WORKSPACE_PATH,
        ...(input.model && input.model !== COMMAND_CODE_TEMPLATE_MODEL
          ? { BOXJOB_CC_MODEL: input.model }
          : {}),
      },
      agent: {
        harness: Agent.Custom,
        customHarness: { command: "node", args: ["/home/boxuser/.local/bin/t3stash-harness.mjs"] },
      },
    };
  const apiKey = input.agentApiKey || BoxApiKey.StoredKey;
  return {
    ...base,
    // The SDK types models as its enums; custom slugs pass through to the Box API unchanged.
    agent:
      input.harness === "claudeCode"
        ? { harness: Agent.ClaudeCode, model: input.model as ClaudeCode, apiKey }
        : { harness: Agent.Codex, model: input.model as OpenAICodex, apiKey },
  };
}
