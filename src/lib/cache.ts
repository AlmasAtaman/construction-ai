import { createHash } from "crypto";
import { db } from "./db";
import { AI_CACHE_TTL_HOURS } from "./constants";

export function makeCacheKey(parts: {
  endpoint: string;
  model: string;
  prompt: string;
  inputHash?: string;
}): string {
  const h = createHash("sha256");
  h.update(parts.endpoint);
  h.update("\0");
  h.update(parts.model);
  h.update("\0");
  h.update(parts.prompt);
  if (parts.inputHash) {
    h.update("\0");
    h.update(parts.inputHash);
  }
  return h.digest("hex");
}

export function hashBuffer(buffer: Buffer | Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function getCached<T = unknown>(
  cacheKey: string,
): Promise<T | null> {
  const now = new Date();
  const entry = await db.aiCache.findUnique({ where: { cacheKey } });
  if (!entry) return null;
  if (entry.expiresAt.getTime() <= now.getTime()) {
    // expired — clean up lazily
    await db.aiCache.delete({ where: { cacheKey } }).catch(() => {});
    return null;
  }
  try {
    return JSON.parse(entry.response) as T;
  } catch {
    return null;
  }
}

export async function setCached(
  cacheKey: string,
  endpoint: string,
  response: unknown,
  ttlHours: number = AI_CACHE_TTL_HOURS,
): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  await db.aiCache.upsert({
    where: { cacheKey },
    update: {
      response: JSON.stringify(response),
      expiresAt,
      endpoint,
    },
    create: {
      cacheKey,
      endpoint,
      response: JSON.stringify(response),
      expiresAt,
    },
  });
}
