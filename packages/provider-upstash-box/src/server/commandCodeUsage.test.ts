import { describe, expect, it } from "@effect/vitest";

import {
  commandCodeApiKey,
  commandCodeUsageFormat,
  commandCodeUsageLimits,
} from "./commandCodeUsage.ts";

const lines = [
  { type: "session", version: 3, id: "session-1", timestamp: "2026-11-17T16:39:42.892Z" },
  {
    type: "message",
    id: "line-1",
    timestamp: "2026-11-17T16:39:43.000Z",
    message: { role: "user", content: [{ type: "text", text: "usage" }] },
  },
  {
    type: "message",
    id: "line-2",
    timestamp: "2026-11-17T16:39:44.366Z",
    message: { role: "assistant", meta: { messageId: "message-1" } },
    usage: {
      inputTokens: 15686,
      outputTokens: 3,
      cacheReadTokens: 5504,
      cacheWriteTokens: 12,
      costUsd: 0.0015456,
    },
    model: "deepseek/deepseek-v4.1-flash",
  },
].map((line) => JSON.stringify(line));

describe("commandCodeUsageFormat", () => {
  it("records assistant usage under the session from the transcript header", () => {
    const state = commandCodeUsageFormat.state!.initial();
    const records = lines.flatMap((line) => commandCodeUsageFormat.parseLine(line, state));
    expect(records).toEqual([
      {
        provider: "commandCode",
        timestampMs: Date.parse("2026-11-17T16:39:44.366Z"),
        model: "deepseek/deepseek-v4.1-flash",
        sessionId: "session-1",
        totals: {
          uncachedInputTokens: 10182,
          cachedInputTokens: 5504,
          cacheCreationTokens: 12,
          outputTokens: 3,
          reasoningTokens: 0,
        },
        reportedCostUsd: 0.0015456,
        speed: "standard",
        dedupeKey: "message-1",
      },
    ]);
  });
});

describe("commandCodeUsageLimits", () => {
  it("maps the plan's 5-hour, weekly, and monthly credit limits", () => {
    const limits = commandCodeUsageLimits({
      checkedAt: "2026-11-24T17:00:00.000Z",
      credits: {
        credits: { monthlyCredits: 39.07, purchasedCredits: 0, freeCredits: 0 },
        windowLimits: {
          limited: true,
          fiveHour: { used: 0, cap: 14, exceeded: false, resetAt: 0 },
          weekly: { used: 8.75, cap: 35, exceeded: false, resetAt: 1795946489992 },
        },
      },
      subscription: { data: { currentPeriodEnd: "2026-12-07T13:14:19.000Z" } },
      summary: { totalMonthlyCredits: 30.93 },
    });
    expect(limits.unavailable).toBeUndefined();
    expect(limits.windows).toEqual([
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent: 0,
        windowDurationMins: 300,
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 25,
        resetsAt: "2026-11-29T10:01:29.992Z",
        windowDurationMins: 10080,
      },
      {
        id: "monthly_credits",
        kind: "monthly",
        label: "Monthly credits",
        usedPercent: (30.93 / 70) * 100,
        resetsAt: "2026-12-07T13:14:19.000Z",
      },
    ]);
  });

  it("reports a failed probe when the reply has no limits", () => {
    const limits = commandCodeUsageLimits({
      checkedAt: "2026-11-24T17:00:00.000Z",
      credits: {},
      subscription: null,
      summary: null,
    });
    expect(limits.windows).toEqual([]);
    expect(limits.unavailable?.reason).toBe("probeFailed");
  });
});

describe("commandCodeApiKey", () => {
  it("reads the key from a stored sign-in or a pasted key", () => {
    expect(commandCodeApiKey(JSON.stringify({ apiKey: "user_abc", userId: "u" }))).toBe("user_abc");
    expect(commandCodeApiKey(" user_abc ")).toBe("user_abc");
    expect(commandCodeApiKey(JSON.stringify({ userId: "u" }))).toBeUndefined();
  });
});
