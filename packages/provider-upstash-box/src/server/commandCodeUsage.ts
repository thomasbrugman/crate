import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import type { TranscriptUsageFormat, UsageRecord } from "@t3tools/provider-core/server/usage";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const COMMAND_CODE_API = "https://api.commandcode.ai";

const CommandCodeUsageState = Schema.Struct({ sessionId: Schema.mutableKey(Schema.String) });
type CommandCodeUsageState = typeof CommandCodeUsageState.Type;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

function parseCommandCodeRecord(projected: unknown, state: CommandCodeUsageState): UsageRecord[] {
  const line = record(projected);
  if (line === undefined) return [];
  if (line["type"] === "session") {
    if (typeof line["id"] === "string") state.sessionId = line["id"];
    return [];
  }
  const usage = record(line["usage"]);
  const message = record(line["message"]);
  const model = line["model"];
  const timestampMs =
    typeof line["timestamp"] === "string" ? Date.parse(line["timestamp"]) : Number.NaN;
  if (
    line["type"] !== "message" ||
    usage === undefined ||
    message?.["role"] !== "assistant" ||
    typeof model !== "string" ||
    model.length === 0 ||
    !Number.isFinite(timestampMs)
  ) {
    return [];
  }
  // Command Code's input count includes the cache reads.
  const cachedInputTokens = count(usage["cacheReadTokens"]);
  const cost = usage["costUsd"];
  const messageId = record(message["meta"])?.["messageId"];
  const id = typeof messageId === "string" ? messageId : line["id"];
  return [
    {
      provider: "commandCode",
      timestampMs,
      model,
      sessionId: state.sessionId,
      totals: {
        uncachedInputTokens: Math.max(0, count(usage["inputTokens"]) - cachedInputTokens),
        cachedInputTokens,
        cacheCreationTokens: count(usage["cacheWriteTokens"]),
        outputTokens: count(usage["outputTokens"]),
        reasoningTokens: 0,
      },
      reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
      speed: "standard",
      dedupeKey: typeof id === "string" ? id : null,
    },
  ];
}

/** Command Code session transcripts (`~/.commandcode/projects/<project>/<session>.jsonl`). */
export const commandCodeUsageFormat: TranscriptUsageFormat<CommandCodeUsageState> = {
  selectFields: {
    type: true,
    id: true,
    timestamp: true,
    model: true,
    usage: true,
    message: { role: true, meta: { messageId: true } },
  },
  usageMarkers: ['"usage"', '"session"'],
  parseLine: (line, state) => {
    try {
      return parseCommandCodeRecord(JSON.parse(line), state);
    } catch {
      return [];
    }
  },
  parseProjected: parseCommandCodeRecord,
  state: {
    initial: () => ({ sessionId: "" }),
    schema: CommandCodeUsageState,
  },
};

const isoTime = (input: number | string) =>
  Option.getOrUndefined(Option.map(DateTime.make(input), DateTime.formatIso));

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;

function capWindow(
  id: string,
  kind: "session" | "weekly",
  label: string,
  windowDurationMins: number,
  value: unknown,
): ServerProviderUsageWindow | undefined {
  const window = record(value);
  const used = window?.["used"];
  const cap = window?.["cap"];
  if (typeof used !== "number" || typeof cap !== "number" || cap <= 0) return undefined;
  const resetAt = window?.["resetAt"];
  const resetsAt = typeof resetAt === "number" && resetAt > 0 ? isoTime(resetAt) : undefined;
  return {
    id,
    kind,
    label,
    usedPercent: clampPercent((used / cap) * 100),
    ...(resetsAt ? { resetsAt } : {}),
    windowDurationMins,
  };
}

/** Maps Command Code's `/alpha/billing/*` and `/alpha/usage/summary` replies to usage windows. */
export function commandCodeUsageLimits(input: {
  readonly checkedAt: string;
  /** The Command Code org or user the sign-in belongs to, so shared sign-ins pool once. */
  readonly account?: string | undefined;
  readonly credits: unknown;
  readonly subscription: unknown;
  readonly summary: unknown;
}): ServerProviderUsageLimits {
  const credits = record(input.credits);
  const limits = record(credits?.["windowLimits"]);
  const windows: ServerProviderUsageWindow[] = [];
  const session = capWindow("five_hour", "session", "Session", SESSION_MINS, limits?.["fiveHour"]);
  if (session) windows.push(session);
  const weekly = capWindow("weekly", "weekly", "Weekly", WEEK_MINS, limits?.["weekly"]);
  if (weekly) windows.push(weekly);
  // `monthlyCredits` is what is left of the plan this period; the summary holds what was spent.
  const remaining = record(credits?.["credits"])?.["monthlyCredits"];
  const spent = record(input.summary)?.["totalMonthlyCredits"];
  if (typeof remaining === "number" && typeof spent === "number" && remaining + spent > 0) {
    const periodEnd = record(record(input.subscription)?.["data"])?.["currentPeriodEnd"];
    const resetsAt = typeof periodEnd === "string" ? isoTime(periodEnd) : undefined;
    windows.push({
      id: "monthly_credits",
      kind: "monthly",
      label: "Monthly credits",
      usedPercent: clampPercent((spent / (remaining + spent)) * 100),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return windows.length > 0
    ? {
        ...makeUsageLimits({ checkedAt: input.checkedAt, windows }),
        ...(input.account ? { credentialFingerprint: `commandCode:${input.account}` } : {}),
      }
    : makeUnavailableUsageLimits({
        checkedAt: input.checkedAt,
        reason: "probeFailed",
        message: "Command Code did not report plan limits.",
      });
}

/** The Command Code API key inside a stored sign-in (`auth.json`) or a pasted key. */
export function commandCodeApiKey(credential: string): string | undefined {
  const value = credential.trim();
  if (!value.startsWith("{")) return value || undefined;
  try {
    const apiKey = record(JSON.parse(value))?.["apiKey"];
    return typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : undefined;
  } catch {
    return undefined;
  }
}

const fetchCommandCodeUsage = Effect.fn("UpstashBox.fetchCommandCodeUsage")(function* (
  apiKey: string,
) {
  const client = yield* HttpClient.HttpClient;
  const get = (endpoint: string, params: Record<string, string | null>) =>
    client
      .execute(
        HttpClientRequest.get(`${COMMAND_CODE_API}${endpoint}`).pipe(
          HttpClientRequest.bearerToken(apiKey),
          HttpClientRequest.setUrlParams(
            Object.fromEntries(Object.entries(params).filter(([, value]) => value !== null)),
          ),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
      );
  const whoami = yield* get("/alpha/whoami", { limits: "1" });
  const orgId = record(record(whoami)?.["org"])?.["id"];
  const userId = record(record(whoami)?.["user"])?.["id"];
  const org = { orgId: typeof orgId === "string" ? orgId : null };
  const [credits, subscription] = yield* Effect.all(
    [get("/alpha/billing/credits", org), get("/alpha/billing/subscriptions", org)],
    { concurrency: "unbounded" },
  );
  const since = record(record(subscription)?.["data"])?.["currentPeriodStart"];
  const summary = yield* get("/alpha/usage/summary", {
    ...org,
    since: typeof since === "string" ? since : null,
  });
  const account = org.orgId ?? (typeof userId === "string" ? userId : undefined);
  return { account, credits, subscription, summary };
});

export const readCommandCodeUsageLimits = Effect.fn("UpstashBox.readCommandCodeUsageLimits")(
  function* (credential: string) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const apiKey = commandCodeApiKey(credential);
    if (apiKey === undefined) return undefined;
    return yield* fetchCommandCodeUsage(apiKey).pipe(
      Effect.timeout("10 seconds"),
      Effect.map((reply) => commandCodeUsageLimits({ checkedAt, ...reply })),
      Effect.orElseSucceed(() =>
        makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "Could not read Command Code plan usage.",
        }),
      ),
    );
  },
);
