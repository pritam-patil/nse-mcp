/**
 * NSE index levels via the same Yahoo chart v8 endpoint as quotes.ts.
 *
 * Index tickers carry a "^" prefix and take no ".NS" suffix, so they bypass
 * the equity symbol normaliser entirely.
 */

import { cacheKey, TTL_DEFAULT_SECONDS, withCache, type Cached, type CacheStore } from "./cache";
import { isDataError, type DataErrorCode } from "./http";
import { fetchChart, mapQuote, type Quote } from "./quotes";

export const NSE_INDICES = {
	NIFTY_50: { label: "NIFTY 50", yahooSymbol: "^NSEI" },
	NIFTY_BANK: { label: "NIFTY BANK", yahooSymbol: "^NSEBANK" },
} as const;

export type IndexKey = keyof typeof NSE_INDICES;

export const INDEX_KEYS = Object.keys(NSE_INDICES) as IndexKey[];

export type IndexQuote = Quote & {
	key: IndexKey;
	label: string;
};

export type IndexFailure = {
	key: IndexKey;
	code: DataErrorCode;
	message: string;
};

export type IndicesResult = {
	indices: IndexQuote[];
	errors: IndexFailure[];
};

/** Fetch one index straight from upstream, bypassing any cache. */
export async function fetchIndex(key: IndexKey): Promise<IndexQuote> {
	const { label, yahooSymbol } = NSE_INDICES[key];
	const raw = await fetchChart(yahooSymbol);
	// Index quotes have no bare NSE symbol, so the Yahoo ticker is the display symbol.
	return { ...mapQuote(raw, yahooSymbol, yahooSymbol), key, label };
}

/** Fetch every index straight from upstream, tolerating partial failure. */
export async function fetchIndices(): Promise<IndicesResult> {
	const settled = await Promise.all(
		INDEX_KEYS.map(async (key): Promise<IndexQuote | IndexFailure> => {
			try {
				return await fetchIndex(key);
			} catch (err) {
				return {
					key,
					code: isDataError(err) ? err.code : "SOURCE_UNAVAILABLE",
					message: err instanceof Error ? err.message : String(err),
				};
			}
		}),
	);

	return {
		indices: settled.filter((r): r is IndexQuote => "source" in r),
		errors: settled.filter((r): r is IndexFailure => !("source" in r)),
	};
}

/** One index, cached for 15 minutes. Pass `store: null` to bypass caching. */
export async function getIndex(
	store: CacheStore | null,
	key: IndexKey,
	now: Date = new Date(),
): Promise<Cached<IndexQuote>> {
	return withCache(store, cacheKey.index(key), TTL_DEFAULT_SECONDS, () => fetchIndex(key), {
		now,
	});
}

/**
 * All indices, cached for 15 minutes under a single key.
 *
 * A partial result is never written to the cache: if one index failed, the
 * previous complete answer is served stale instead. Only when there is nothing
 * cached at all does the partial result go out, with its `errors` populated.
 */
export async function getIndices(
	store: CacheStore | null,
	now: Date = new Date(),
): Promise<Cached<IndicesResult>> {
	return withCache(store, cacheKey.indices(), TTL_DEFAULT_SECONDS, fetchIndices, {
		now,
		shouldCache: (result) => result.errors.length === 0,
	});
}
