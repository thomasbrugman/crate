import {
  Agent,
  Box,
  BoxApiKey,
  BoxError,
  type BoxConfig,
  type Chunk,
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

export const BOX_WORKSPACE_PATH = "/workspace/home";
export const BOX_REPOSITORY_PATH = "/workspace/home/repo";

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

export interface BoxStream extends AsyncIterable<Chunk> {
  readonly id: string;
  readonly cancel: () => Promise<void>;
}

export interface BoxHandle {
  readonly id: string;
  readonly agent: { readonly stream: (options: StreamOptions) => Promise<BoxStream> };
  readonly exec: {
    readonly command: (
      command: string,
    ) => Promise<{ readonly stdout: string; readonly exitCode: number | null }>;
  };
  readonly files: {
    readonly write: (options: { path: string; content: string }) => Promise<unknown>;
  };
  readonly delete: () => Promise<unknown>;
  readonly resume: () => Promise<void>;
  readonly getStatus: () => Promise<{ readonly status: string }>;
}

export class BoxApi extends Context.Service<
  BoxApi,
  {
    readonly get: (id: string, apiKey: string) => Promise<BoxHandle>;
    readonly create: (config: BoxConfig) => Promise<BoxHandle>;
    readonly list: (apiKey: string) => Promise<unknown>;
    /** The HTTP status the model provider answers a cheap authenticated request with. */
    readonly checkModelKey: (harness: ManagedAgentHarness, apiKey: string) => Promise<number>;
  }
>()("@t3tools/provider-upstash-box/server/BoxApi") {}

export const layer = Layer.succeed(BoxApi, {
  get: (id, apiKey) => Box.get(id, { apiKey }),
  create: (config) => Box.create(config),
  list: (apiKey) => Box.list({ apiKey }),
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
