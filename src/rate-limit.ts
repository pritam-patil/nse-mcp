/**
 * Simple per-IP rate limiting on a KV counter.
 *
 * One counter per IP per clock hour: read, compare, increment. KV is
 * eventually consistent and the read+write is not atomic, so a burst can
 * overshoot the cap slightly — acceptable for a courtesy limit on a free
 * service, not a security boundary. Costs one KV read + one KV write per
 * tool call; on Cloudflare's free tier (1,000 KV writes/day) real traffic
 * would exhaust writes, at which point the Workers native rate-limiting
 * binding (no KV) is the upgrade path.
 *
 * Fails open: if KV reads/writes error, or no client IP is available, the
 * call is allowed — a broken limiter must not take the service down.
 */

import type { CacheStore } from "./data";

/** Tool calls allowed per IP per clock hour. */
export const RATE_LIMIT_PER_HOUR = 60;

const HOUR_MS = 3_600_000;

/** Counter key for this IP in the current clock-hour bucket. */
export function rateLimitKey(ip: string, now: Date): string {
	return `v1:rl:${ip}:${Math.floor(now.getTime() / HOUR_MS)}`;
}

export type RateLimitResult = {
	allowed: boolean;
	/** Whole minutes until the current hour bucket resets (when blocked). */
	retryMinutes: number;
};

/** Check and count one call for `ip`. Null/missing IP is always allowed. */
export async function checkRateLimit(
	store: CacheStore,
	ip: string | null,
	now: Date = new Date(),
	limit: number = RATE_LIMIT_PER_HOUR,
): Promise<RateLimitResult> {
	if (!ip) return { allowed: true, retryMinutes: 0 };

	const key = rateLimitKey(ip, now);
	const raw = await store.get(key).catch(() => null);
	const count = raw ? Number.parseInt(raw, 10) || 0 : 0;

	if (count >= limit) {
		const msLeft = HOUR_MS - (now.getTime() % HOUR_MS);
		return { allowed: false, retryMinutes: Math.max(1, Math.ceil(msLeft / 60_000)) };
	}

	// Expire well after the bucket ends; KV requires a TTL of at least 60s.
	await store.put(key, String(count + 1), { expirationTtl: 2 * 3600 }).catch(() => {});
	return { allowed: true, retryMinutes: 0 };
}

/** The friendly message shown to a rate-limited caller. */
export function rateLimitMessage(retryMinutes: number): string {
	return (
		`This free server allows ${RATE_LIMIT_PER_HOUR} requests per hour per IP, and you've ` +
		`reached that limit. Please try again in about ${retryMinutes} minute${retryMinutes === 1 ? "" : "s"}.`
	);
}
