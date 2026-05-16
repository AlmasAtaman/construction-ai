// Hard limits enforced in code. Tweak these to adjust safety nets.

export const DAILY_SPEND_CEILING_USD = 20;
export const WARN_THRESHOLD_PCT = 0.8;

// Per-project per-day limits
export const MAX_TAKEOFF_RUNS_PER_PAGE_PER_DAY = 5;
export const MAX_SPEC_RUNS_PER_DOC_PER_DAY = 3;
export const MAX_CHAT_MESSAGES_PER_PROJECT_PER_DAY = 100;

// Global limits
export const MAX_AI_CALLS_PER_MINUTE = 50;

// Cache TTL
export const AI_CACHE_TTL_HOURS = 24;

// Pricing (per million tokens). Cache reads cost ~10% of input.
// Cache writes are billed at 1.25x input for ephemeral entries.
export const PRICING = {
  "claude-sonnet-4-5": {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  },
  "claude-haiku-4-5": {
    inputPerMillion: 1,
    outputPerMillion: 5,
    cacheReadPerMillion: 0.1,
    cacheWritePerMillion: 1.25,
  },
  "claude-haiku-4-5-20251001": {
    inputPerMillion: 1,
    outputPerMillion: 5,
    cacheReadPerMillion: 0.1,
    cacheWritePerMillion: 1.25,
  },
} as const;

export const DEFAULT_MODEL = "claude-sonnet-4-5";

// Confirmation threshold for expensive ops (USD)
export const EXPENSIVE_OP_THRESHOLD = 1;
