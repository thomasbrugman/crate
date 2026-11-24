import {
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const payloadFields = {
  appThread: Schema.toCodecJson(OrchestrationV2AppThread),
  providerThread: Schema.toCodecJson(OrchestrationV2ProviderThread),
  existingProviderThread: Schema.toCodecJson(OrchestrationV2ProviderThread),
  resumeFromSession: Schema.toCodecJson(OrchestrationV2ProviderSession),
  sourceProviderThread: Schema.toCodecJson(OrchestrationV2ProviderThread),
  sourceProviderTurns: Schema.toCodecJson(Schema.Array(OrchestrationV2ProviderTurn)),
  providerThreadTurns: Schema.toCodecJson(Schema.Array(OrchestrationV2ProviderTurn)),
};

const thread = Schema.toCodecJson(OrchestrationV2ProviderThread);
const snapshot = Schema.toCodecJson(
  Schema.Struct({
    providerThread: OrchestrationV2ProviderThread,
    providerTurns: Schema.Array(OrchestrationV2ProviderTurn),
    messages: Schema.Array(OrchestrationV2ConversationMessage),
    reasoningMessageIds: Schema.optionalKey(
      Schema.Array(OrchestrationV2ConversationMessage.fields.id),
    ),
    runtimeRequests: Schema.Array(OrchestrationV2RuntimeRequest),
    providerPayload: Schema.optionalKey(Schema.Unknown),
  }),
);

export function sessionPayload(method: string, value: unknown, direction: "encode" | "decode") {
  if (typeof value !== "object" || value === null) return value;
  const output: Record<string, unknown> = { ...value };
  for (const key of Object.keys(payloadFields) as (keyof typeof payloadFields)[]) {
    if (!(key in output)) continue;
    const codec = payloadFields[key];
    output[key] =
      direction === "encode"
        ? Schema.encodeUnknownSync(codec)(output[key])
        : Schema.decodeUnknownSync(codec)(output[key]);
  }
  if (
    method === "rollbackThread" &&
    typeof output.target === "object" &&
    output.target !== null &&
    "providerTurn" in output.target
  ) {
    const codec = Schema.toCodecJson(OrchestrationV2ProviderTurn);
    output.target = {
      ...output.target,
      providerTurn:
        direction === "encode"
          ? Schema.encodeUnknownSync(codec)(output.target.providerTurn)
          : Schema.decodeUnknownSync(codec)(output.target.providerTurn),
    };
  }
  return output;
}

export function sessionResult(method: string, value: unknown, direction: "encode" | "decode") {
  const codec =
    method === "ensureThread" || method === "resumeThread" || method === "forkThread"
      ? thread
      : method === "readThreadSnapshot" || method === "rollbackThread"
        ? snapshot
        : undefined;
  if (codec === undefined) return value;
  return direction === "encode"
    ? Schema.encodeUnknownSync(codec)(value)
    : Schema.decodeUnknownSync(codec)(value);
}
