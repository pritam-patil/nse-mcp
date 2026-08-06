/**
 * Market status via NSE /api/marketStatus.
 *
 * This is the authoritative source for whether NSE is trading, and it answered
 * 200 on every spike run without any header tricks (see DATA_SOURCES.md).
 *
 * Two properties of the real payload drive the mapping here:
 *  - Segments disagree. Commodity can be "Open" while Capital Market is
 *    "Closed", so the headline status is taken from Capital Market
 *    specifically, never from "is any segment open".
 *  - Numeric fields are loosely typed: `last` arrives as a number, as "" when
 *    absent, and as a numeric string like "95.0100".
 */

import { cacheKey, statusTtlSeconds, withCache, type Cached, type CacheStore } from "./cache";
import { fetchJson } from "./http";

export const NSE_MARKET_STATUS_URL = "https://www.nseindia.com/api/marketStatus";
const SOURCE = "nse-market-status";

/** The segment NSE uses for cash equities — the one that defines "is NSE open". */
export const HEADLINE_SEGMENT = "Capital Market";

export type MarketStatusValue = "open" | "closed" | "unknown";

export type RawMarketState = {
	market?: unknown;
	marketStatus?: unknown;
	tradeDate?: unknown;
	index?: unknown;
	last?: unknown;
	variation?: unknown;
	percentChange?: unknown;
	marketStatusMessage?: unknown;
};

export type MarketSegment = {
	market: string;
	status: MarketStatusValue;
	/** NSE's own wording, e.g. "Closed". */
	statusRaw: string | null;
	tradeDate: string | null;
	index: string | null;
	last: number | null;
	variation: number | null;
	percentChange: number | null;
	message: string | null;
};

export type MarketStatus = {
	market: "NSE";
	/** Derived from the Capital Market segment only. */
	status: MarketStatusValue;
	headlineSegment: string;
	segments: MarketSegment[];
	source: typeof SOURCE;
};

function str(v: unknown): string | null {
	if (typeof v !== "string") return null;
	const t = v.trim();
	return t === "" ? null : t;
}

/** Accepts numbers and numeric strings; "" and junk become null. */
function looseNum(v: unknown): number | null {
	if (typeof v === "number") return Number.isFinite(v) ? v : null;
	const s = str(v);
	if (s === null) return null;
	const n = Number(s);
	return Number.isFinite(n) ? n : null;
}

export function normalizeStatus(raw: unknown): MarketStatusValue {
	const s = str(raw)?.toLowerCase();
	if (!s) return "unknown";
	// Check "close" first: "Closed" contains neither "open" nor a trap, but
	// ordering keeps phrases like "Pre Open Closed" resolving sensibly.
	if (s.includes("close")) return "closed";
	if (s.includes("open")) return "open";
	return "unknown";
}

export function mapMarketSegment(raw: RawMarketState): MarketSegment {
	return {
		market: str(raw?.market) ?? "",
		status: normalizeStatus(raw?.marketStatus),
		statusRaw: str(raw?.marketStatus),
		tradeDate: str(raw?.tradeDate),
		index: str(raw?.index),
		last: looseNum(raw?.last),
		variation: looseNum(raw?.variation),
		percentChange: looseNum(raw?.percentChange),
		message: str(raw?.marketStatusMessage),
	};
}

export function mapMarketStatus(raw: unknown): MarketStatus {
	const states = (raw as { marketState?: unknown })?.marketState;
	const segments = Array.isArray(states)
		? states
				.filter((s): s is RawMarketState => typeof s === "object" && s !== null)
				// The payload also carries a NIFTY50-USD row with no `market` key;
				// it is a quote, not a segment, so it is dropped here.
				.filter((s) => str(s.market) !== null)
				.map(mapMarketSegment)
		: [];

	const headline = segments.find(
		(s) => s.market.toLowerCase() === HEADLINE_SEGMENT.toLowerCase(),
	);

	return {
		market: "NSE",
		status: headline?.status ?? "unknown",
		headlineSegment: HEADLINE_SEGMENT,
		segments,
		source: SOURCE,
	};
}

/** Fetch market status straight from upstream, bypassing any cache. */
export async function fetchMarketStatus(): Promise<MarketStatus> {
	const raw = await fetchJson<unknown>(NSE_MARKET_STATUS_URL, {
		source: SOURCE,
		headers: { Referer: "https://www.nseindia.com/" },
	});
	return mapMarketStatus(raw);
}

/**
 * Market status, cached with the same market-hours-aware TTL as quotes, and
 * additionally clamped so an entry cannot outlive the open or close it
 * describes (see `statusTtlSeconds`). Pass `store: null` to bypass caching.
 */
export async function getMarketStatus(
	store: CacheStore | null,
	now: Date = new Date(),
): Promise<Cached<MarketStatus>> {
	return withCache(store, cacheKey.status(), statusTtlSeconds(now), fetchMarketStatus, { now });
}
