/**
 * Historical OHLC price series via Yahoo chart v8's range/interval params.
 *
 * Yahoo returns parallel arrays: `timestamp[]` plus `indicators.quote[0]` with
 * `open/high/low/close/volume[]`. The requested range is validated against the
 * response's `meta.validRanges`; interval-vs-range combos are checked up front
 * so an over-long combo is rejected with a helpful message rather than pulling
 * thousands of bars. Results are capped at ~60 rows (downsampled if longer).
 */

import { cacheKey, TTL_HISTORY_SECONDS, withCache, type Cached, type CacheStore } from "./cache";
import { DataError, fetchJson } from "./http";
import { normalizeSymbol, toYahooSymbol, YAHOO_CHART_BASE } from "./quotes";

const SOURCE = "yahoo-chart-v8";

/** Hard cap on returned rows; longer series are downsampled to this. */
export const MAX_ROWS = 60;

export const DEFAULT_RANGE = "1mo";
export const DEFAULT_INTERVAL = "1d";

/** Ranges Yahoo accepts (also cross-checked against meta.validRanges per response). */
export const KNOWN_RANGES = [
	"1d",
	"5d",
	"1mo",
	"3mo",
	"6mo",
	"1y",
	"2y",
	"5y",
	"10y",
	"ytd",
	"max",
] as const;

/** Intervals Yahoo accepts. */
export const KNOWN_INTERVALS = [
	"1m",
	"2m",
	"5m",
	"15m",
	"30m",
	"60m",
	"90m",
	"1h",
	"1d",
	"5d",
	"1wk",
	"1mo",
	"3mo",
] as const;

export type Range = (typeof KNOWN_RANGES)[number];
export type Interval = (typeof KNOWN_INTERVALS)[number];

/** Approximate span of each range in days, for combo sanity-checking. */
const RANGE_DAYS: Record<Range, number> = {
	"1d": 1,
	"5d": 5,
	"1mo": 31,
	"3mo": 93,
	"6mo": 186,
	"1y": 366,
	"2y": 731,
	"5y": 1827,
	"10y": 3653,
	ytd: 366,
	max: Number.POSITIVE_INFINITY,
};

/**
 * How far back each interval can reach, matching Yahoo's own limits. Minute
 * granularities are only kept for short windows; daily and coarser have no
 * practical ceiling here.
 */
const INTERVAL_MAX_DAYS: Record<Interval, number> = {
	"1m": 7,
	"2m": 60,
	"5m": 60,
	"15m": 60,
	"30m": 60,
	"90m": 60,
	"60m": 730,
	"1h": 730,
	"1d": Number.POSITIVE_INFINITY,
	"5d": Number.POSITIVE_INFINITY,
	"1wk": Number.POSITIVE_INFINITY,
	"1mo": Number.POSITIVE_INFINITY,
	"3mo": Number.POSITIVE_INFINITY,
};

export type OhlcRow = {
	/** Epoch seconds, as Yahoo sends it. */
	t: number;
	open: number | null;
	high: number | null;
	low: number | null;
	close: number | null;
	volume: number | null;
};

export type PriceHistory = {
	symbol: string;
	yahooSymbol: string;
	range: Range;
	interval: Interval;
	/** The granularity Yahoo actually returned (meta.dataGranularity). */
	granularity: string | null;
	currency: string | null;
	timezone: string | null;
	/** Whether the interval is intraday, so the formatter shows a time of day. */
	intraday: boolean;
	rows: OhlcRow[];
	/** Row count before downsampling, when it exceeded MAX_ROWS; else null. */
	downsampledFrom: number | null;
};

type ChartQuote = {
	open?: (number | null)[];
	high?: (number | null)[];
	low?: (number | null)[];
	close?: (number | null)[];
	volume?: (number | null)[];
};

type HistoryResponse = {
	chart?: {
		result?: Array<{
			meta?: {
				validRanges?: string[];
				dataGranularity?: string;
				currency?: string;
				exchangeTimezoneName?: string;
			};
			timestamp?: number[];
			indicators?: { quote?: ChartQuote[] };
		}> | null;
		error?: { code?: string; description?: string } | null;
	};
};

function isIntraday(interval: Interval): boolean {
	return interval.endsWith("m") || interval.endsWith("h");
}

/**
 * Validate the requested range/interval and their combination.
 *
 * Throws NOT_FOUND with a message a caller (or a model) can act on: what the
 * valid values are, or which interval to use for a longer range.
 */
export function validateRangeInterval(
	range: string,
	interval: string,
): {
	range: Range;
	interval: Interval;
} {
	if (!(KNOWN_RANGES as readonly string[]).includes(range)) {
		throw new DataError(
			"NOT_FOUND",
			`invalid range "${range}". Use one of: ${KNOWN_RANGES.join(", ")}`,
			{
				source: SOURCE,
			},
		);
	}
	if (!(KNOWN_INTERVALS as readonly string[]).includes(interval)) {
		throw new DataError(
			"NOT_FOUND",
			`invalid interval "${interval}". Use one of: ${KNOWN_INTERVALS.join(", ")}`,
			{ source: SOURCE },
		);
	}
	const r = range as Range;
	const i = interval as Interval;
	if (RANGE_DAYS[r] > INTERVAL_MAX_DAYS[i]) {
		throw new DataError(
			"NOT_FOUND",
			`interval "${i}" only covers about ${INTERVAL_MAX_DAYS[i]} days, but range "${r}" is longer. ` +
				`Use a coarser interval (e.g. 1d or 1wk) for this range, or a shorter range.`,
			{ source: SOURCE },
		);
	}
	return { range: r, interval: i };
}

/** Keep at most MAX_ROWS rows, evenly spaced, always retaining first and last. */
export function downsample(rows: OhlcRow[], max = MAX_ROWS): OhlcRow[] {
	if (rows.length <= max) return rows;
	const step = (rows.length - 1) / (max - 1);
	const out: OhlcRow[] = [];
	for (let k = 0; k < max; k++) out.push(rows[Math.round(k * step)]);
	return out;
}

function num(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Map a raw chart response into a PriceHistory, validating the range against
 * the response's own meta.validRanges and dropping bars with no close.
 */
export function mapHistory(
	raw: unknown,
	displaySymbol: string,
	yahooSymbol: string,
	range: Range,
	interval: Interval,
): PriceHistory {
	const chart = (raw as HistoryResponse)?.chart;
	const result = chart?.result?.[0];

	if (!result) {
		const desc = chart?.error?.description ?? "no chart data in response";
		throw new DataError("NOT_FOUND", `${SOURCE}: ${displaySymbol}: ${desc}`, {
			source: SOURCE,
		});
	}

	const meta = result.meta ?? {};
	if (Array.isArray(meta.validRanges) && !meta.validRanges.includes(range)) {
		throw new DataError(
			"NOT_FOUND",
			`range "${range}" is not available for ${displaySymbol}. Available: ${meta.validRanges.join(", ")}`,
			{ source: SOURCE },
		);
	}

	const ts = result.timestamp ?? [];
	const q = result.indicators?.quote?.[0] ?? {};
	const all: OhlcRow[] = [];
	for (let k = 0; k < ts.length; k++) {
		const close = num(q.close?.[k]);
		// A bar with no close is a gap (holiday/halt) — skip it.
		if (close === null) continue;
		all.push({
			t: ts[k],
			open: num(q.open?.[k]),
			high: num(q.high?.[k]),
			low: num(q.low?.[k]),
			close,
			volume: num(q.volume?.[k]),
		});
	}

	const rows = downsample(all);
	return {
		symbol: displaySymbol,
		yahooSymbol,
		range,
		interval,
		granularity: meta.dataGranularity ?? null,
		currency: meta.currency ?? null,
		timezone: meta.exchangeTimezoneName ?? null,
		intraday: isIntraday(interval),
		rows,
		downsampledFrom: all.length > rows.length ? all.length : null,
	};
}

/** Fetch a raw history document for a resolved Yahoo symbol + range + interval. */
export async function fetchHistory(
	yahooSymbol: string,
	range: Range,
	interval: Interval,
): Promise<HistoryResponse> {
	const url =
		`${YAHOO_CHART_BASE}/${encodeURIComponent(yahooSymbol)}` +
		`?range=${range}&interval=${interval}`;
	return fetchJson<HistoryResponse>(url, { source: SOURCE });
}

/**
 * Historical OHLC for a plain NSE symbol, cached for one hour.
 *
 * Range/interval default to 1mo/1d and are validated before any request. Pass
 * `store: null` to bypass caching. Throws {@link DataError} (NOT_FOUND for a
 * bad symbol or combo) on failure.
 */
export async function getPriceHistory(
	store: CacheStore | null,
	symbol: string,
	rangeInput: string = DEFAULT_RANGE,
	intervalInput: string = DEFAULT_INTERVAL,
	now: Date = new Date(),
): Promise<Cached<PriceHistory>> {
	const display = normalizeSymbol(symbol);
	const yahoo = toYahooSymbol(display);
	const { range, interval } = validateRangeInterval(rangeInput, intervalInput);

	return withCache(
		store,
		cacheKey.history(display, range, interval),
		TTL_HISTORY_SECONDS,
		async () =>
			mapHistory(await fetchHistory(yahoo, range, interval), display, yahoo, range, interval),
		{ now },
	);
}
