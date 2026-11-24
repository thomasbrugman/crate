import { TextGenerationError } from "@t3tools/contracts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import { toJsonSchemaObject } from "@t3tools/provider-core/server/textGenerationUtils";
import { BoxError } from "@upstash/box";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";

import { BOX_HARNESS_LABELS, type BoxHarness } from "../harnesses.ts";
import type { BoxEnvironmentConfig } from "./adapter.ts";
import { BoxApi, BOX_HOME, BOX_WORKSPACE_PATH, type BoxHandle, quoteShell } from "./BoxApi.ts";
import { BOX_HARNESS_PATH, BOX_MANAGED_HARNESS_PATH, ensureBox } from "./bootstrap.ts";
import { harnessCredentialKind } from "./credentials.ts";
import { execHarness } from "./execHarness.ts";

const TEXT_GENERATION_TIMEOUT_MS = 180_000;
// The prompt travels as one shell argument, which Linux caps at 128 KiB.
const MAX_PROMPT_BYTES = 96_000;

/** One small Box per harness answers every auxiliary prompt; it sleeps between requests. */
export const textGenerationBoxName = (harness: BoxHarness) =>
  `t3-text-${Buffer.from(harness).toString("hex")}`;

export function textGenerationCommand(input: {
  readonly harness: BoxHarness;
  readonly prompt: string;
  readonly model: string;
  readonly credentialKind: string;
}): string {
  const model = input.model.replace(/^(?:openai|anthropic)\//u, "");
  const args =
    input.harness === "commandCode"
      ? [
          BOX_HARNESS_PATH,
          "-p",
          input.prompt,
          "--explicit-session",
          ...(model === "default" ? [] : ["--model", model]),
        ]
      : [BOX_MANAGED_HARNESS_PATH, input.harness, input.prompt, model, "", input.credentialKind];
  const cwd = BOX_WORKSPACE_PATH;
  return `cd ${cwd} && PATH=${BOX_HOME}/.local/bin:$PATH BOXJOB_CC_CWD=${cwd} exec node ${args.map(quoteShell).join(" ")}`;
}

function limitBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  return `${bytes
    .subarray(0, maxBytes)
    .toString()
    .replace(/\uFFFD$/u, "")}\n[truncated]`;
}

export function structuredPrompt(prompt: string, schema: unknown): string {
  return `${limitBytes(prompt, MAX_PROMPT_BYTES)}\n\nDo not use any tools. Reply with only a JSON object that matches this JSON Schema, with no other text:\n${JSON.stringify(schema)}`;
}

async function collectReply(
  box: BoxHandle,
  start: (box: BoxHandle) => Promise<AsyncIterable<unknown> & { cancel: () => Promise<void> }>,
  signal: AbortSignal,
): Promise<string> {
  let stream: Awaited<ReturnType<typeof start>>;
  try {
    stream = await start(box);
  } catch (error) {
    if (!(error instanceof BoxError) || error.statusCode !== 409) throw error;
    await box.resume();
    stream = await start(box);
  }
  const cancel = () => void stream.cancel().catch(() => undefined);
  signal.addEventListener("abort", cancel, { once: true });
  let text = "";
  let output = "";
  try {
    for await (const chunk of stream as AsyncIterable<{
      readonly type: string;
      readonly text?: string;
      readonly output?: string;
    }>) {
      if (chunk.type === "text-delta") text += chunk.text ?? "";
      else if (chunk.type === "finish") output = chunk.output ?? "";
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  return text.trim() ? text : output;
}

export const makeBoxTextGeneration = Effect.fn("UpstashBox.makeTextGeneration")(function* (
  harness: BoxHarness,
  agentApiKey: string,
  environment: Effect.Effect<BoxEnvironmentConfig>,
) {
  const api = yield* BoxApi;
  const label = `${BOX_HARNESS_LABELS[harness]} in Upstash Box`;
  const run: TextGenerationOperations.Runner = Effect.fn("UpstashBox.generateText")(function* <
    S extends Schema.Top,
  >(request: TextGenerationOperations.Request<S>) {
    const fail = (detail: string, cause?: unknown) =>
      new TextGenerationError({
        operation: request.operation,
        detail,
        ...(cause === undefined ? {} : { cause }),
      });
    const config = yield* environment;
    const credential = config.credentials?.[harness] || agentApiKey;
    const credentialKind = harnessCredentialKind(harness, credential);
    if (config.credentials && !credentialKind)
      return yield* fail("Connect this harness in Settings → Providers.");
    const box = yield* ensureBox(
      {
        ...config,
        size: "small",
        harness,
        model: request.modelSelection.model,
        agentApiKey,
        // Prompts carry untrusted issue and PR text, so this Box never holds GitHub credentials.
        githubToken: "",
      },
      textGenerationBoxName(harness),
    ).pipe(
      Effect.provideService(BoxApi, api),
      Effect.mapError((cause) => fail("Could not start the text generation Box.", cause)),
    );
    const prompt = structuredPrompt(request.prompt, toJsonSchemaObject(request.outputSchema));
    const reply = yield* Effect.tryPromise({
      try: (signal) =>
        collectReply(
          box,
          (target) =>
            config.credentials
              ? execHarness(
                  target,
                  textGenerationCommand({
                    harness,
                    prompt,
                    model: request.modelSelection.model,
                    credentialKind: credentialKind ?? "",
                  }),
                )
              : target.agent.stream({ prompt }),
          signal,
        ),
      catch: (cause) => fail(`${label} could not generate text.`, cause),
    }).pipe(
      Effect.timeoutOption(TEXT_GENERATION_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(fail(`${label} timed out.`)),
          onSome: Effect.succeed,
        }),
      ),
    );
    return yield* TextGenerationOperations.decodeJsonReply(request, label, reply);
  });
  return TextGenerationOperations.fromRunner(
    label,
    TextGenerationOperations.withoutInvestigation(label, run),
  ) satisfies ProviderTextGeneration;
});
