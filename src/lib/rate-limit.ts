/**
 * Minimal in-memory rate limiter (SRS: "Secure meeting rooms" /
 * "Meeting Security" — general auth hardening, not meeting-specific, but
 * the same section covers it). Caps how many times a given key (IP +
 * route) can hit a limited endpoint within a rolling window, to slow down
 * password-guessing against /api/auth/login.
 *
 * Deliberately simple and explicitly scoped: an in-memory Map only works
 * within a single Node process — sufficient for local dev and a typical
 * small single-instance deployment. It would NOT coordinate correctly
 * across multiple app instances behind a load balancer; a real
 * multi-instance deployment would need a shared store (Redis) instead.
 * Flagged here rather than silently assumed.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Returns true if the request identified by `key` is still within its
 * allowance for this window, incrementing its count as a side effect.
 * Returns false once `limit` has been hit until `windowMs` has elapsed
 * since the first request in the current window.
 */
export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (bucket.count >= limit) {
    return false;
  }

  bucket.count += 1;
  return true;
}

/** Best-effort client identifier from standard proxy headers, falling back
 *  to a constant when none are present (e.g. direct local dev requests) —
 *  better than throwing, though it does mean local requests all share one
 *  bucket in that fallback case. */
export function getClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp;
  return "unknown";
}
