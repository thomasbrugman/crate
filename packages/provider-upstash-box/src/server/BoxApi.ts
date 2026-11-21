import { Agent, Box, BoxError, type BoxConfig, type Chunk, type StreamOptions } from "@upstash/box";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class BoxRuntimeError extends Schema.TaggedError<BoxRuntimeError>()("BoxRuntimeError", {
  operation: Schema.String,
  statusCode: Schema.optional(Schema.Number),
}) {}

export interface BoxStream extends AsyncIterable<Chunk> {
  readonly id: string;
  readonly cancel: () => Promise<void>;
}

export interface BoxHandle {
  readonly id: string;
  readonly agent: { readonly stream: (options: StreamOptions) => Promise<BoxStream> };
  readonly exec: {
    readonly command: (command: string) => Promise<{
      readonly stdout: string;
      readonly stderr?: string;
      readonly exitCode: number | null;
    }>;
  };
  readonly files: {
    readonly write: (options: { path: string; content: string }) => Promise<unknown>;
  };
  readonly delete: () => Promise<unknown>;
}

export class BoxApi extends Context.Service<
  BoxApi,
  {
    readonly get: (id: string, apiKey: string) => Promise<BoxHandle>;
    readonly create: (config: BoxConfig) => Promise<BoxHandle>;
    readonly list: (apiKey: string) => Promise<unknown>;
  }
>()("@t3tools/provider-upstash-box/server/BoxApi") {}

export const layer = Layer.succeed(BoxApi, {
  get: (id, apiKey) => Box.get(id, { apiKey }),
  create: (config) => Box.create(config),
  list: (apiKey) => Box.list({ apiKey }),
});

export function isMissingBox(error: unknown): boolean {
  return error instanceof BoxError && error.statusCode === 404;
}

export function boxConfig(input: {
  apiKey: string;
  name: string;
  size: BoxConfig["size"];
  model: string;
  repositoryUrl?: string;
}): BoxConfig {
  return {
    apiKey: input.apiKey,
    name: input.name,
    runtime: "node",
    size: input.size ?? "small",
    keepAlive: false,
    labels: ["t3stash"],
    env: {
      BOXJOB_CC_BIN: "/home/boxuser/.local/bin/command-code",
      BOXJOB_CC_CWD: input.repositoryUrl ? "/workspace/home/repo" : "/workspace/home",
      ...(input.model ? { BOXJOB_CC_MODEL: input.model } : {}),
    },
    agent: {
      harness: Agent.Custom,
      customHarness: { command: "node", args: ["/home/boxuser/.local/bin/t3stash-harness.mjs"] },
    },
  };
}
