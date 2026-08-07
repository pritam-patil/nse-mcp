/**
 * Render structured data as compact `label: value` text for an LLM to read,
 * rather than raw JSON. Every rendering ends with an "as of <IST timestamp>"
 * line so the model can state data freshness, and marks stale data explicitly.
 */

import type {
	AnnouncementsResult,
	Cached,
	CorporateActionsResult,
	IndexKey,
	IndicesResult,
	MarketStatus,
	PriceHistory,
	Quote,
	SymbolEntry,
} from "./data";
import { IST_OFFSET_MINUTES, NSE_INDICES } from "./data";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Group the integer part with commas: 20203425 → "20,203,425". */
function group(intDigits: string): string {
	return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Fixed-decimal number with thousands separators, e.g. 1325 → "1,325.00". */
function num(value: number, decimals = 2): string {
	const fixed = Math.abs(value).toFixed(decimals);
	const [int, frac] = fixed.split(".");
	const sign = value < 0 ? "-" : "";
	const grouped = group(int);
	return frac ? `${sign}${grouped}.${frac}` : `${sign}${grouped}`;
}

/** Signed number, e.g. +45.00 / -4.15. */
function signed(value: number, decimals = 2): string {
	return `${value >= 0 ? "+" : ""}${num(value, decimals)}`;
}

/** Signed percentage, e.g. +3.52% / -0.04%. */
function signedPct(value: number): string {
	return `${signed(value, 2)}%`;
}

/**
 * ISO 8601 → "07-Aug-2026 00:02 IST".
 *
 * IST is UTC+05:30 year-round (no DST), so the offset trick is exact — the same
 * assumption market-hours.ts relies on.
 */
export function istTimestamp(iso: string | null | undefined): string | null {
	if (!iso) return null;
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return null;
	const ist = new Date(d.getTime() + IST_OFFSET_MINUTES * 60_000);
	const dd = String(ist.getUTCDate()).padStart(2, "0");
	const mon = MONTHS[ist.getUTCMonth()];
	const yyyy = ist.getUTCFullYear();
	const hh = String(ist.getUTCHours()).padStart(2, "0");
	const mm = String(ist.getUTCMinutes()).padStart(2, "0");
	return `${dd}-${mon}-${yyyy} ${hh}:${mm} IST`;
}

/** Epoch seconds → IST parts, sharing the offset trick with istTimestamp. */
function istParts(epochSeconds: number): { date: string; time: string } {
	const ist = new Date(epochSeconds * 1000 + IST_OFFSET_MINUTES * 60_000);
	const dd = String(ist.getUTCDate()).padStart(2, "0");
	const mon = MONTHS[ist.getUTCMonth()];
	const yyyy = ist.getUTCFullYear();
	const hh = String(ist.getUTCHours()).padStart(2, "0");
	const mm = String(ist.getUTCMinutes()).padStart(2, "0");
	return { date: `${dd}-${mon}-${yyyy}`, time: `${hh}:${mm}` };
}

/** Cap a list to at most 25 items; the shared limit for every list output. */
export const MAX_LIST_ITEMS = 25;

/** An IST as-of string from a cache/refresh timestamp, or a plain fallback. */
function asOfFrom(iso: string | null | undefined): string {
	return istTimestamp(iso) ?? "just now";
}

/** Compose body lines, a possible stale note, and the trailing "as of" line. */
function compose(lines: string[], asOf: string, stale: boolean): string {
	const out = [...lines];
	if (stale) {
		out.push("Note: stale — upstream unavailable, showing last cached value.");
	}
	out.push(`as of ${asOf}`);
	return out.join("\n");
}

/** Symbol search results as "SYMBOL — Company Name" lines, one per match. */
export function formatSymbolMatches(
	matches: SymbolEntry[],
	query: string,
	listUpdatedAt?: string | null,
): string {
	const asOf = istTimestamp(listUpdatedAt) ?? "unknown";
	const capped = matches.slice(0, MAX_LIST_ITEMS);
	if (capped.length === 0) {
		return compose([`No NSE symbols match "${query}".`], asOf, false);
	}
	return compose(
		capped.map((m) => `${m.symbol} — ${m.name}`),
		asOf,
		false,
	);
}

/** Corporate announcements: date, headline, and link per item, newest first. */
export function formatAnnouncements(
	result: Cached<AnnouncementsResult>,
	opts: { symbol?: string } = {},
): string {
	const asOf = asOfFrom(result.cachedAt);
	const announcements = result.announcements.slice(0, MAX_LIST_ITEMS);
	if (announcements.length === 0) {
		const who = opts.symbol ? ` for ${opts.symbol.toUpperCase()}` : "";
		return compose([`No recent announcements${who}.`], asOf, result.stale);
	}

	const lines = announcements.map((a) => {
		const when = istTimestamp(a.announcedAtIso) ?? a.announcedAt ?? "date unknown";
		const sym = !opts.symbol && a.symbol ? `${a.symbol}: ` : "";
		const headline = a.description ?? "(no description)";
		const link = a.attachmentUrl ? `\n  ${a.attachmentUrl}` : "";
		return `${when} — ${sym}${headline}${link}`;
	});
	return compose(lines, asOf, result.stale);
}

/** Corporate actions: type, purpose, ex-date and record date per item, newest first. */
export function formatCorporateActions(
	result: Cached<CorporateActionsResult>,
	symbol: string,
): string {
	const asOf = asOfFrom(result.cachedAt);
	const actions = result.actions.slice(0, MAX_LIST_ITEMS);
	if (actions.length === 0) {
		return compose(
			[`No recent corporate actions for ${symbol.toUpperCase()}.`],
			asOf,
			result.stale,
		);
	}

	const lines = actions.map((a) => {
		const subject = a.subject ?? a.type;
		const ex = a.exDate ? `ex-date ${a.exDate}` : "ex-date n/a";
		const rec = a.recordDate ? `, record ${a.recordDate}` : "";
		return `${a.type}: ${subject} (${ex}${rec})`;
	});
	return compose(lines, asOf, result.stale);
}

/** Historical OHLC series: a header, one compact row per bar, oldest to newest. */
export function formatPriceHistory(h: Cached<PriceHistory>): string {
	const currency = h.currency ?? "INR";
	const header =
		`${h.symbol} — ${h.range} @ ${h.interval}` +
		(h.downsampledFrom ? ` (${h.downsampledFrom} bars downsampled to ${h.rows.length})` : "") +
		` — OHLC in ${currency}`;

	if (h.rows.length === 0) {
		return compose([header, "No price data for this range."], asOfFrom(h.cachedAt), h.stale);
	}

	const rows = h.rows.map((r) => {
		const { date, time } = istParts(r.t);
		const when = h.intraday ? `${date} ${time}` : date;
		const cells = [
			`O ${r.open !== null ? num(r.open) : "n/a"}`,
			`H ${r.high !== null ? num(r.high) : "n/a"}`,
			`L ${r.low !== null ? num(r.low) : "n/a"}`,
			`C ${r.close !== null ? num(r.close) : "n/a"}`,
			`V ${r.volume !== null ? num(r.volume, 0) : "n/a"}`,
		];
		return `${when}  ${cells.join("  ")}`;
	});

	const last = h.rows[h.rows.length - 1];
	const { date, time } = istParts(last.t);
	const asOf = `${date}${h.intraday ? ` ${time}` : ""} IST`;
	return compose([header, ...rows], asOf, h.stale);
}

/** One NSE equity quote. */
export function formatQuote(q: Cached<Quote>): string {
	const nameEx = [q.name, q.exchange].filter(Boolean).join(", ");
	const currency = q.currency ?? "INR";
	const lines: string[] = [`${q.symbol}${nameEx ? ` — ${nameEx}` : ""}`];

	lines.push(q.price !== null ? `Price: ${num(q.price)} ${currency}` : "Price: n/a");

	if (q.change !== null && q.changePercent !== null) {
		lines.push(`Change: ${signed(q.change)} (${signedPct(q.changePercent)})`);
	}
	if (q.previousClose !== null) lines.push(`Prev close: ${num(q.previousClose)}`);
	if (q.dayLow !== null && q.dayHigh !== null) {
		lines.push(`Day range: ${num(q.dayLow)}–${num(q.dayHigh)}`);
	}
	if (q.fiftyTwoWeekLow !== null && q.fiftyTwoWeekHigh !== null) {
		lines.push(`52-week range: ${num(q.fiftyTwoWeekLow)}–${num(q.fiftyTwoWeekHigh)}`);
	}
	if (q.volume !== null) lines.push(`Volume: ${num(q.volume, 0)}`);

	const asOf = istTimestamp(q.asOf) ?? istTimestamp(q.cachedAt) ?? "unknown";
	return compose(lines, asOf, q.stale);
}

/** All NSE indices, one line each, with any unavailable ones noted. */
export function formatIndices(result: Cached<IndicesResult>): string {
	const lines: string[] = [];

	for (const idx of result.indices) {
		const parts = [idx.label + ":"];
		parts.push(idx.price !== null ? num(idx.price) : "n/a");
		if (idx.change !== null && idx.changePercent !== null) {
			parts.push(`${signed(idx.change)} (${signedPct(idx.changePercent)})`);
		}
		lines.push(parts.join(" "));
	}

	for (const err of result.errors) {
		const label = NSE_INDICES[err.key as IndexKey]?.label ?? err.key;
		lines.push(`${label}: unavailable (${err.code})`);
	}

	if (lines.length === 0) lines.push("No index data available.");

	// The latest per-index reading is the most honest "as of" for the set.
	const latest = result.indices
		.map((i) => i.asOf)
		.filter((t): t is string => Boolean(t))
		.sort()
		.at(-1);
	const asOf = istTimestamp(latest) ?? istTimestamp(result.cachedAt) ?? "unknown";
	return compose(lines, asOf, result.stale);
}

/** NSE market status: headline, per-segment detail, and the headline index. */
export function formatMarketStatus(status: Cached<MarketStatus>): string {
	const headline = status.segments.find(
		(s) => s.market.toLowerCase() === status.headlineSegment.toLowerCase(),
	);

	const lines: string[] = [`NSE market: ${status.status.toUpperCase()}`];

	if (headline) {
		const msg = headline.message ? ` — ${headline.message}` : "";
		lines.push(`${headline.market}: ${headline.statusRaw ?? "unknown"}${msg}`);
		if (headline.index && headline.last !== null) {
			const pct =
				headline.percentChange !== null ? ` (${signedPct(headline.percentChange)})` : "";
			lines.push(`${headline.index}: ${num(headline.last)}${pct}`);
		}
	}

	const others = status.segments
		.filter((s) => s !== headline)
		.map((s) => `${s.market} ${s.statusRaw ?? "unknown"}`);
	if (others.length > 0) lines.push(`Other segments: ${others.join(", ")}`);

	// tradeDate is already IST wall-clock ("06-Aug-2026 15:30"); prefer it, since
	// cachedAt would report when we fetched, not when the session data applies.
	const asOf = headline?.tradeDate
		? `${headline.tradeDate} IST`
		: (istTimestamp(status.cachedAt) ?? "unknown");
	return compose(lines, asOf, status.stale);
}
