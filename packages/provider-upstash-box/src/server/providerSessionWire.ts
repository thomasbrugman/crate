import * as Schema from "effect/Schema";
import { OrchestrationV2ProviderSession } from "@t3tools/contracts";
import { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";

const Call = Schema.Struct({
  id: Schema.Number,
  method: Schema.String,
  payload: Schema.optionalKey(Schema.Unknown),
});

const Frame = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("startup_failure"),
    reason: Schema.Literals(["launch", "authentication"]),
  }),
  Schema.Struct({
    type: Schema.Literal("ready"),
    methods: Schema.Array(Schema.String),
    providerSession: Schema.optionalKey(OrchestrationV2ProviderSession),
  }),
  Schema.Struct({
    type: Schema.Literal("result"),
    id: Schema.Number,
    value: Schema.optionalKey(Schema.Unknown),
  }),
  Schema.Struct({
    type: Schema.Literal("failure"),
    id: Schema.Number,
    reason: Schema.optionalKey(Schema.Literal("authentication")),
  }),
  Schema.Struct({ type: Schema.Literal("event"), event: ProviderAdapterV2Event }),
]);

export type ProviderSessionCall = typeof Call.Type;
export type ProviderSessionFrame = typeof Frame.Type;

export const decodeCall = Schema.decodeUnknownSync(Schema.fromJsonString(Call));
const FrameJson = Schema.fromJsonString(Schema.toCodecJson(Frame));
export const decodeFrame = Schema.decodeUnknownSync(FrameJson);
export const encodeCall = Schema.encodeSync(Schema.fromJsonString(Call));
export const encodeFrame = Schema.encodeSync(FrameJson);
