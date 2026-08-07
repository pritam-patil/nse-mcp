/**
 * KV-backed caching for the data modules.
 *
 * Freshness is tracked in the stored envelope rather than by KV expiry, because
 * the two jobs are different: the TTL decides when to *refresh*, while the KV
 * entry has to outlive that so there is still something to serve when an
 * upstream fails. Entries are therefore kept for {@link STALE_RETENTION_SECONDS}
 * and judged fresh or stale on read.
 */

import { isMarketHours, secondsUntilNextBoundary } from "./market-hours";

/** Refresh interval for quotes while NSE is trading. */
export const TTL_MARKET_HOURS_SECONDS = 60;

/** Refresh interval outside trading hours, and for indices and announcements. */
export const TTL_DEFAULT_SECONDS = 15 * 60;

/** How long an entry survives in KV so it can still be served stale. */
export const STALE_RETENTION_SECONDS = 7 * 24 * 60 * 60;

/** Floor for a boundary-clamped TTL, so a near-boundary read still caches briefly. */
const MIN_TTL_SECONDS = 15;

/** The slice of KVNamespace this module needs; keeps tests free of KV stubs. */
export interface CacheStore {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

export function kvCache(kv: KVNamespace): CacheStore {
	return {
		get: (key) => kv.get(key, "text"),
		put: (key, value, opts) => kv.put(key, value, opts),
	};
}

export type CacheMeta = {
	/** True when the upstream failed and this is the last known good value. */
	stale: boolean;
	/** When the served value was fetched, ISO 8601; null if never cached. */
	cachedAt: string | null;
};

export type Cached<T> = T & CacheMeta;

/** Namespaced cache keys. Format: `v1:<kind>:<id>`. */
export const cacheKey = {
	quote: (symbol: string) => `v1:quote:${symbol}`,
	index: (key: string) => `v1:index:${key}`,
	indices: () => "v1:indices",
	announcements: (symbol?: string) =>
		symbol ? `v1:announcements:sym:${symbol}` : "v1:announcements:equities",
	corporateActions: (symbol: string) => `v1:corpactions:${symbol}`,
	status: () => "v1:status",
	symbols: () => "v1:symbols",
};

type Envelope<T> = {
	v: 1;
	storedAt: string;
	data: T;
};

function readEnvelope<T>(raw: string | null): Envelope<T> | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Envelope<T>;
		if (parsed?.v !== 1 || typeof parsed.storedAt !== "string" || !("data" in parsed)) {
			return null;
		}
		return Number.isNaN(Date.parse(parsed.storedAt)) ? null : parsed;
	} catch {
		// A corrupt or older-format entry is treated as a miss, not an error.
		return null;
	}
}

export type WithCacheOptions<T> = {
	now?: Date;
	/**
	 * Whether a freshly fetched value is worth storing. When it returns false
	 * and a previous entry exists, that entry is served stale instead — a
	 * complete older answer beats a degraded new one.
	 */
	shouldCache?: (value: T) => boolean;
};

/** Quote TTL: tight while NSE trades, relaxed otherwise. */
export function quoteTtlSeconds(now: Date): number {
	return isMarketHours(now) ? TTL_MARKET_HOURS_SECONDS : TTL_DEFAULT_SECONDS;
}

/**
 * Market-status TTL, clamped so an entry cannot outlive the open or close it
 * describes. Without the clamp, a "closed" cached at 09:14 would still be
 * served at 09:29, a quarter of an hour after trading began.
 */
export function statusTtlSeconds(now: Date): number {
	const base = isMarketHours(now) ? TTL_MARKET_HOURS_SECONDS : TTL_DEFAULT_SECONDS;
	return Math.max(MIN_TTL_SECONDS, Math.min(base, secondsUntilNextBoundary(now)));
}

/**
 * Serve `key` from cache when fresh, otherwise refetch.
 *
 * On upstream failure the last cached value is returned with `stale: true`.
 * With no cached value to fall back on, the upstream error propagates.
 */
export async function withCache<T extends object>(
	store: CacheStore | null,
	key: string,
	ttlSeconds: number,
	fetcher: () => Promise<T>,
	opts: WithCacheOptions<T> = {},
): Promise<Cached<T>> {
	const now = opts.now ?? new Date();
	const entry = store ? readEnvelope<T>(await store.get(key).catch(() => null)) : null;

	if (entry) {
		const ageSeconds = (now.getTime() - Date.parse(entry.storedAt)) / 1000;
		if (ageSeconds >= 0 && ageSeconds < ttlSeconds) {
			return { ...entry.data, stale: false, cachedAt: entry.storedAt };
		}
	}

	try {
		const fresh = await fetcher();

		if (opts.shouldCache && !opts.shouldCache(fresh)) {
			// Degraded result: prefer the older complete answer if we have one.
			if (entry) return { ...entry.data, stale: true, cachedAt: entry.storedAt };
			return { ...fresh, stale: false, cachedAt: null };
		}

		const storedAt = now.toISOString();
		if (store) {
			const envelope: Envelope<T> = { v: 1, storedAt, data: fresh };
			// A cache write failure must not fail the request.
			await store
				.put(key, JSON.stringify(envelope), { expirationTtl: STALE_RETENTION_SECONDS })
				.catch(() => {});
		}
		return { ...fresh, stale: false, cachedAt: storedAt };
	} catch (err) {
		if (entry) return { ...entry.data, stale: true, cachedAt: entry.storedAt };
		throw err;
	}
}
