import { db } from "./db";
import {
  DAILY_SPEND_CEILING_USD,
  MAX_AI_CALLS_PER_MINUTE,
  PRICING,
  WARN_THRESHOLD_PCT,
} from "./constants";

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; reason: string };

function startOfDay(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(): Date {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
}

/**
 * Reserve one slot under `key`. Atomic increment-and-check using SQLite
 * upsert + conditional update so concurrent callers cannot overshoot.
 * If the existing window has expired we reset it.
 */
export async function checkRateLimit(
  key: string,
  max: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const now = new Date();
  const newResetAt = new Date(now.getTime() + windowSeconds * 1000);

  const counter = await db.rateLimitCounter.upsert({
    where: { key },
    update: {},
    create: { key, count: 0, resetAt: newResetAt },
  });

  // Reset window if expired.
  if (counter.resetAt.getTime() <= now.getTime()) {
    await db.rateLimitCounter.update({
      where: { key },
      data: { count: 1, resetAt: newResetAt },
    });
    return { allowed: true };
  }

  if (counter.count >= max) {
    return {
      allowed: false,
      reason: `You've reached the limit for "${friendlyKey(key)}" (${max} per window). Please wait and try again.`,
    };
  }

  await db.rateLimitCounter.update({
    where: { key },
    data: { count: { increment: 1 } },
  });
  return { allowed: true };
}

function friendlyKey(key: string): string {
  if (key.startsWith("takeoff:")) return "AI takeoff on this page";
  if (key.startsWith("specs:")) return "spec analysis on this document";
  if (key.startsWith("chat:")) return "chat messages on this project";
  if (key === "global:per-minute") return "AI calls per minute";
  return key;
}

export interface CostBreakdown {
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  breakdown: CostBreakdown = {},
): number {
  const pricing = PRICING[model as keyof typeof PRICING];
  if (!pricing) return 0;
  const cacheRead = breakdown.cacheReadInputTokens ?? 0;
  const cacheWrite = breakdown.cacheCreationInputTokens ?? 0;
  // Anthropic reports input_tokens EXCLUDING cache_read and cache_creation
  // tokens, so we add the cache components separately at their own rate.
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion +
    (cacheRead / 1_000_000) * (pricing.cacheReadPerMillion ?? 0) +
    (cacheWrite / 1_000_000) * (pricing.cacheWritePerMillion ?? 0)
  );
}

export async function trackApiUsage(
  endpoint: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  breakdown: CostBreakdown = {},
): Promise<{ estimatedCost: number }> {
  const estimatedCost = estimateCost(
    model,
    inputTokens,
    outputTokens,
    breakdown,
  );

  // Store cache tokens folded into inputTokens so existing reports still add up.
  const totalInputTokens =
    inputTokens +
    (breakdown.cacheReadInputTokens ?? 0) +
    (breakdown.cacheCreationInputTokens ?? 0);

  await db.apiUsage.create({
    data: {
      endpoint,
      model,
      inputTokens: totalInputTokens,
      outputTokens,
      estimatedCost,
    },
  });

  if (process.env.NODE_ENV === "development") {
    const cacheStr =
      breakdown.cacheReadInputTokens || breakdown.cacheCreationInputTokens
        ? ` | cache r:${breakdown.cacheReadInputTokens ?? 0} w:${breakdown.cacheCreationInputTokens ?? 0}`
        : "";
    // eslint-disable-next-line no-console
    console.log(
      `[AI] ${endpoint} | ${model} | in: ${inputTokens} tok | out: ${outputTokens} tok${cacheStr} | est: $${estimatedCost.toFixed(4)}`,
    );
  }

  return { estimatedCost };
}

export async function getDailySpend(): Promise<number> {
  const result = await db.apiUsage.aggregate({
    _sum: { estimatedCost: true },
    where: {
      createdAt: { gte: startOfDay(), lte: endOfDay() },
    },
  });
  return result._sum.estimatedCost ?? 0;
}

export async function getDailySpendPercent(): Promise<number> {
  const spend = await getDailySpend();
  return spend / DAILY_SPEND_CEILING_USD;
}

export async function isDailyBudgetExceeded(): Promise<boolean> {
  return (await getDailySpend()) >= DAILY_SPEND_CEILING_USD;
}

export async function isDailyBudgetWarning(): Promise<boolean> {
  return (await getDailySpendPercent()) >= WARN_THRESHOLD_PCT;
}

/**
 * Combined gate every AI route should call before invoking Anthropic.
 * Returns either { allowed: true } or { allowed: false, status, reason }
 * suitable for returning to the client.
 */
export async function gateAiCall(opts: {
  perCallerKey: string;
  perCallerMax: number;
  perCallerWindowSeconds: number;
}): Promise<
  | { allowed: true }
  | { allowed: false; status: 429 | 402; reason: string }
> {
  if (await isDailyBudgetExceeded()) {
    return {
      allowed: false,
      status: 402,
      reason:
        "Daily AI usage limit reached. AI features will resume tomorrow. You can still edit projects manually.",
    };
  }

  const global = await checkRateLimit(
    "global:per-minute",
    MAX_AI_CALLS_PER_MINUTE,
    60,
  );
  if (!global.allowed) {
    return { allowed: false, status: 429, reason: global.reason };
  }

  const perCaller = await checkRateLimit(
    opts.perCallerKey,
    opts.perCallerMax,
    opts.perCallerWindowSeconds,
  );
  if (!perCaller.allowed) {
    return { allowed: false, status: 429, reason: perCaller.reason };
  }

  return { allowed: true };
}
