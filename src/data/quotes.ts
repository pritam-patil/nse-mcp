/**
 * Equity quotes via Yahoo Finance chart v8.
 *
 * NSE's own quote-equity endpoint returns 403 from every origin tested (see
 * DATA_SOURCES.md), so Yahoo is the quote source. Only `chart.result[0].meta`
 * is read — the candle arrays are ignored.
 *
 * Do not switch to Yahoo's v7/finance/quote: it is crumb-gated and answers 401.
 */

import { DataError, fetchJson } from "./http";

export const YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
const SOURCE = "yahoo-chart-v8";

/** Only the `meta` fields this module maps; Yahoo sends considerably more. */
export type YahooChartMeta = {
	symbol?: string;
	shortName?: string;
	longName?: string;
	currency?: string;
	exchangeName?: string;
	fullExchangeName?: string;
	exchangeTimezoneName?: string;
	regularMarketPrice?: number;
	previousClose?: number;
	chartPreviousClose?: number;
	regularMarketDayHigh?: number;
	regularMarketDayLow?: number;
	regularMarketVolume?: number;
	fiftyTwoWeekHigh?: number;
	fiftyTwoWeekLow?: number;
	/** Epoch **seconds**, not milliseconds. */
	regularMarketTime?: number;
};

export type YahooChartResponse = {
	chart?: {
		result?: Array<{ meta?: YahooChartMeta }> | null;
		error?: { code?: string; description?: string } | null;
	};
};

export type Quote = {
	/** Plain NSE symbol as the caller should see it, e.g. "RELIANCE". */
	symbol: string;
	/** What was actually requested upstream, e.g. "RELIANCE.NS". */
	yahooSymbol: string;
	name: string | null;
	currency: string | null;
	exchange: string | null;
	price: number | null;
	previousClose: number | null;
	change: number | null;
	changePercent: number | null;
	dayHigh: number | null;
	dayLow: number | null;
	volume: number | null;
	fiftyTwoWeekHigh: number | null;
	fiftyTwoWeekLow: number | null;
	/** ISO 8601, derived from regularMarketTime. */
	asOf: string | null;
	source: typeof SOURCE;
};

/** NSE symbols are alphanumeric plus & - _ (M&M, BAJAJ-AUTO). */
const SYMBOL_RE = /^[A-Z0-9&\-_]{1,20}$/;

function num(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
	if (typeof v !== "string") return null;
	const t = v.trim();
	return t === "" ? null : t;
}

function round2(v: number): number {
	return Math.round(v * 100) / 100;
}

/** Epoch seconds → ISO 8601. Yahoo sends seconds; Date wants milliseconds. */
export function epochSecondsToIso(sec: unknown): string | null {
	const n = num(sec);
	if (n === null || n <= 0) return null;
	const d = new Date(n * 1000);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Accepts "reliance", "RELIANCE", or "RELIANCE.NS" and returns the bare symbol.
 * Throws NOT_FOUND for input that cannot be an NSE symbol, so callers get the
 * same typed error whether the symbol is malformed or merely unknown upstream.
 */
export function normalizeSymbol(input: string): string {
	const raw = (input ?? "").trim().toUpperCase().replace(/\.NS$/, "");
	if (!SYMBOL_RE.test(raw)) {
		throw new DataError("NOT_FOUND", `invalid NSE symbol: ${JSON.stringify(input)}`, {
			source: SOURCE,
		});
	}
	return raw;
}

/** Index symbols (^NSEI) pass through untouched; equities gain the .NS suffix. */
export function toYahooSymbol(symbol: string): string {
	return symbol.startsWith("^") ? symbol : `${symbol}.NS`;
}

/**
 * Map a raw chart response onto a Quote.
 *
 * `displaySymbol` is what the caller asked for; `yahooSymbol` is what was sent
 * upstream. Throws NOT_FOUND when the payload carries no usable meta — Yahoo
 * signals unknown symbols both by 404 and by a null result with an error block.
 */
export function mapQuote(
	raw: YahooChartResponse,
	displaySymbol: string,
	yahooSymbol: string,
): Quote {
	const chart = raw?.chart;
	const meta = chart?.result?.[0]?.meta;

	if (!meta) {
		const desc = str(chart?.error?.description) ?? "no chart data in response";
		throw new DataError("NOT_FOUND", `${SOURCE}: ${displaySymbol}: ${desc}`, {
			source: SOURCE,
		});
	}

	const price = num(meta.regularMarketPrice);
	// previousClose is the official prior session close; chartPreviousClose is a
	// chart-range artifact and only stands in when the former is absent.
	const previousClose = num(meta.previousClose) ?? num(meta.chartPreviousClose);

	const change = price !== null && previousClose !== null ? round2(price - previousClose) : null;
	const changePercent =
		price !== null && previousClose !== null && previousClose !== 0
			? round2(((price - previousClose) / previousClose) * 100)
			: null;

	return {
		symbol: displaySymbol,
		yahooSymbol,
		name: str(meta.longName) ?? str(meta.shortName),
		currency: str(meta.currency),
		exchange: str(meta.fullExchangeName) ?? str(meta.exchangeName),
		price,
		previousClose,
		change,
		changePercent,
		dayHigh: num(meta.regularMarketDayHigh),
		dayLow: num(meta.regularMarketDayLow),
		volume: num(meta.regularMarketVolume),
		fiftyTwoWeekHigh: num(meta.fiftyTwoWeekHigh),
		fiftyTwoWeekLow: num(meta.fiftyTwoWeekLow),
		asOf: epochSecondsToIso(meta.regularMarketTime),
		source: SOURCE,
	};
}

/** Fetch a raw chart document for an already-resolved Yahoo symbol. */
export async function fetchChart(yahooSymbol: string): Promise<YahooChartResponse> {
	const url = `${YAHOO_CHART_BASE}/${encodeURIComponent(yahooSymbol)}`;
	return fetchJson<YahooChartResponse>(url, { source: SOURCE });
}

/** Fetch a quote for a plain NSE symbol (the ".NS" suffix is added internally). */
export async function getQuote(symbol: string): Promise<Quote> {
	const display = normalizeSymbol(symbol);
	const yahoo = toYahooSymbol(display);
	return mapQuote(await fetchChart(yahoo), display, yahoo);
}
