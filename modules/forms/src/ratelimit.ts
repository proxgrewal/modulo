/** Fixed-window-ish sliding log rate limiter, in memory (per process). */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    readonly limit = 5,
    readonly windowMs = 60_000,
  ) {}

  /** Record an attempt; returns false when the key is over its limit. */
  hit(key: string, now = Date.now()): boolean {
    const since = now - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.prune(now);
    return true;
  }

  prune(now = Date.now()) {
    const since = now - this.windowMs;
    for (const [k, v] of this.hits) if (!v.some((t) => t > since)) this.hits.delete(k);
  }

  reset() {
    this.hits.clear();
  }
}

/** Shared limiter for form submissions: 5 per minute per (site, form, ip hash). */
export const submissionLimiter = new RateLimiter(5, 60_000);

/** Salted SHA-256 of the client IP so raw addresses are never stored. */
export async function hashIp(ip: string, salt: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
