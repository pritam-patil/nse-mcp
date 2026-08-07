/**
 * Corporate actions via NSE /api/corporates-corporateActions.
 *
 * Reachable from both Cloudflare and a residential IP (probed in Burse 7, see
 * DATA_SOURCES.md). Returns dividends, bonuses, splits, rights, etc. with their
 * ex-dates and record dates. Called per symbol.
 */

import { cacheKey, TTL_DEFAULT_SECONDS, withCache, type Cached, type CacheStore } from "./cache";
import { parseNseDate } from "./dates";
import { fetchJson } from "./http";
import { normalizeSymbol } from "./quotes";

const BASE = "https://www.nseindia.com/api/corporates-corporateActions?index=equities";
export const NSE_CORPORATE_ACTIONS_URL = BASE;
const SOURCE = "nse-corporate-actions";

export type CorporateActionType =
	| "Dividend"
	| "Bonus"
	| "Split"
	| "Rights"
	| "Demerger"
	| "AGM"
	| "Other";

export type RawCorporateAction = {
	symbol?: unknown;
	comp?: unknown;
	subject?: unknown;
	exDate?: unknown;
	recDate?: unknown;
	series?: unknown;
	faceVal?: unknown;
};

export type CorporateAction = {
	symbol: string | null;
	company: string | null;
	type: CorporateActionType;
	/** NSE's free-text purpose, e.g. "Dividend - Rs 6 Per Share", "Bonus 1:1". */
	subject: string | null;
	/** As NSE sends it, e.g. "05-Jun-2026". */
	exDate: string | null;
	/** "YYYY-MM-DD" for sorting/machine use, or null. */
	exDateIso: string | null;
	recordDate: string | null;
	series: string | null;
	source: typeof SOURCE;
};

export type CorporateActionsResult = {
	actions: CorporateAction[];
};

function str(v: unknown): string | null {
	if (typeof v !== "string") return null;
	const t = v.trim();
	// NSE uses "-" as a placeholder for absent dates.
	return t === "" || t === "-" ? null : t;
}

/**
 * Classify from the free-text subject. A single subject can name more than one
 * action (e.g. "Annual General Meeting/Dividend"); the concrete cash/stock
 * action is preferred over the meeting, and demerger over a generic split.
 */
export function classifyAction(subject: string | null): CorporateActionType {
	const s = (subject ?? "").toLowerCase();
	if (s.includes("dividend")) return "Dividend";
	if (s.includes("bonus")) return "Bonus";
	if (s.includes("demerger")) return "Demerger";
	if (s.includes("split") || s.includes("sub-division") || s.includes("face value")) {
		return "Split";
	}
	if (s.includes("rights")) return "Rights";
	if (s.includes("annual general meeting") || s.includes("agm")) return "AGM";
	return "Other";
}

export function mapCorporateAction(raw: RawCorporateAction): CorporateAction {
	const exDate = str(raw?.exDate);
	const subject = str(raw?.subject);
	return {
		symbol: str(raw?.symbol),
		company: str(raw?.comp),
		type: classifyAction(subject),
		subject,
		exDate,
		exDateIso: parseNseDate(exDate),
		recordDate: str(raw?.recDate),
		series: str(raw?.series),
		source: SOURCE,
	};
}

/** Map the array, skip non-objects, and sort by ex-date, newest first. */
export function mapCorporateActions(raw: unknown): CorporateAction[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((r): r is RawCorporateAction => typeof r === "object" && r !== null)
		.map(mapCorporateAction)
		.sort((a, b) => (b.exDateIso ?? "").localeCompare(a.exDateIso ?? ""));
}

/** Fetch corporate actions for one symbol straight from upstream. */
export async function fetchCorporateActions(symbol: string): Promise<CorporateActionsResult> {
	const raw = await fetchJson<unknown>(`${BASE}&symbol=${encodeURIComponent(symbol)}`, {
		source: SOURCE,
		headers: { Referer: `https://www.nseindia.com/get-quotes/equity?symbol=${symbol}` },
	});
	return { actions: mapCorporateActions(raw) };
}

/**
 * Corporate actions for one symbol, cached 15 minutes, newest first.
 *
 * An invalid symbol yields an empty result rather than throwing. Pass
 * `store: null` to bypass caching.
 */
export async function getCorporateActions(
	store: CacheStore | null,
	symbol: string,
	now: Date = new Date(),
): Promise<Cached<CorporateActionsResult>> {
	let normalized: string;
	try {
		normalized = normalizeSymbol(symbol);
	} catch {
		return { actions: [], stale: false, cachedAt: null };
	}
	return withCache(
		store,
		cacheKey.corporateActions(normalized),
		TTL_DEFAULT_SECONDS,
		() => fetchCorporateActions(normalized),
		{ now },
	);
}
