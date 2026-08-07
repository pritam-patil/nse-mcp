/**
 * Corporate announcements via NSE /api/corporate-announcements.
 *
 * This endpoint answered 200 on every spike run, from Cloudflare and from a
 * residential IP, with and without cookies — so it is called plainly, with
 * only a browser-like User-Agent and a Referer.
 *
 * Two modes:
 *  - No symbol: the recent all-equities feed (~20 latest across every company).
 *  - A symbol: that company's announcements, bounded to a recent date window,
 *    because the unbounded per-symbol response is the full history (multiple MB).
 */

import { cacheKey, TTL_DEFAULT_SECONDS, withCache, type Cached, type CacheStore } from "./cache";
import { parseNseDate } from "./dates";
import { fetchJson } from "./http";
import { normalizeSymbol } from "./quotes";

const BASE = "https://www.nseindia.com/api/corporate-announcements?index=equities";
export const NSE_ANNOUNCEMENTS_URL = BASE;
const SOURCE = "nse-corporate-announcements";

const REFERER = "https://www.nseindia.com/companies-listing/corporate-filings-announcements";

/** How far back a per-symbol query reaches. Keeps the payload small (~tens of KB). */
export const ANNOUNCEMENT_WINDOW_DAYS = 90;

/** The subset of NSE's record shape this module maps. */
export type RawAnnouncement = {
	symbol?: unknown;
	sm_name?: unknown;
	desc?: unknown;
	an_dt?: unknown;
	attchmntFile?: unknown;
};

export type Announcement = {
	symbol: string | null;
	company: string | null;
	description: string | null;
	/** Exactly as NSE sends it, e.g. "06-Aug-2026 22:04:15" (IST). */
	announcedAt: string | null;
	/** The same instant as ISO 8601 with the +05:30 offset, or null if unparseable. */
	announcedAtIso: string | null;
	attachmentUrl: string | null;
	source: typeof SOURCE;
};

function str(v: unknown): string | null {
	if (typeof v !== "string") return null;
	const t = v.trim();
	return t === "" ? null : t;
}

/**
 * "06-Aug-2026 22:04:15" → "2026-08-06T22:04:15+05:30".
 *
 * Announcements always carry a time; a date-only value is treated as missing
 * so `announcedAtIso` stays a full timestamp or null.
 */
export function parseAnnouncementDate(value: unknown): string | null {
	const iso = parseNseDate(value);
	return iso && iso.includes("T") ? iso : null;
}

export function mapAnnouncement(raw: RawAnnouncement): Announcement {
	const announcedAt = str(raw?.an_dt);
	return {
		symbol: str(raw?.symbol),
		company: str(raw?.sm_name),
		description: str(raw?.desc),
		announcedAt,
		announcedAtIso: parseAnnouncementDate(announcedAt),
		attachmentUrl: str(raw?.attchmntFile),
		source: SOURCE,
	};
}

/**
 * Map the top-level array, skip non-objects, and sort newest first.
 *
 * Records with a parseable date sort before those without; the source is
 * usually already newest-first, but sorting makes "top N" reliable.
 */
export function mapAnnouncements(raw: unknown, limit?: number): Announcement[] {
	if (!Array.isArray(raw)) return [];
	const mapped = raw
		.filter((r): r is RawAnnouncement => typeof r === "object" && r !== null)
		.map(mapAnnouncement)
		.sort((a, b) => (b.announcedAtIso ?? "").localeCompare(a.announcedAtIso ?? ""));
	return typeof limit === "number" && limit >= 0 ? mapped.slice(0, limit) : mapped;
}

export type AnnouncementsResult = {
	announcements: Announcement[];
};

/** dd-mm-yyyy in IST, the format NSE's from_date/to_date expect. */
function nseDateParam(date: Date): string {
	const ist = new Date(date.getTime() + 330 * 60_000);
	const dd = String(ist.getUTCDate()).padStart(2, "0");
	const mm = String(ist.getUTCMonth() + 1).padStart(2, "0");
	return `${dd}-${mm}-${ist.getUTCFullYear()}`;
}

function buildUrl(symbol: string | null, now: Date): string {
	if (!symbol) return BASE;
	const to = nseDateParam(now);
	const from = nseDateParam(new Date(now.getTime() - ANNOUNCEMENT_WINDOW_DAYS * 86_400_000));
	return `${BASE}&symbol=${encodeURIComponent(symbol)}&from_date=${from}&to_date=${to}`;
}

/** Fetch announcements straight from upstream (optionally for one symbol). */
export async function fetchAnnouncements(
	opts: { symbol?: string | null; now?: Date } = {},
): Promise<AnnouncementsResult> {
	const now = opts.now ?? new Date();
	const raw = await fetchJson<unknown>(buildUrl(opts.symbol ?? null, now), {
		source: SOURCE,
		headers: { Referer: REFERER },
	});
	return { announcements: mapAnnouncements(raw) };
}

/**
 * Recent announcements, cached for 15 minutes, newest first.
 *
 * With no symbol, the all-equities feed is cached under one key; with a symbol,
 * that company's recent window is cached under its own key. `limit` is applied
 * on read so callers with different limits share one entry. An invalid symbol
 * yields an empty result rather than throwing. Pass `store: null` to bypass.
 */
export async function getAnnouncements(
	store: CacheStore | null,
	opts: { symbol?: string; limit?: number; now?: Date } = {},
): Promise<Cached<AnnouncementsResult>> {
	const now = opts.now ?? new Date();

	let symbol: string | null = null;
	if (opts.symbol) {
		try {
			symbol = normalizeSymbol(opts.symbol);
		} catch {
			// Unknown/garbage symbol: no announcements, not an error.
			return { announcements: [], stale: false, cachedAt: null };
		}
	}

	const result = await withCache(
		store,
		cacheKey.announcements(symbol ?? undefined),
		TTL_DEFAULT_SECONDS,
		() => fetchAnnouncements({ symbol, now }),
		{ now },
	);
	if (typeof opts.limit !== "number" || opts.limit < 0) return result;
	return { ...result, announcements: result.announcements.slice(0, opts.limit) };
}
