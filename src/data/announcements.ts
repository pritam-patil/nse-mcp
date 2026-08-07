/**
 * Corporate announcements via NSE /api/corporate-announcements.
 *
 * This endpoint answered 200 on every spike run, from Cloudflare and from a
 * residential IP, with and without cookies — so it is called plainly, with
 * only a browser-like User-Agent and a Referer.
 */

import { cacheKey, TTL_DEFAULT_SECONDS, withCache, type Cached, type CacheStore } from "./cache";
import { fetchJson } from "./http";

export const NSE_ANNOUNCEMENTS_URL =
	"https://www.nseindia.com/api/corporate-announcements?index=equities";
const SOURCE = "nse-corporate-announcements";

const REFERER = "https://www.nseindia.com/companies-listing/corporate-filings-announcements";

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

const MONTHS: Record<string, string> = {
	JAN: "01",
	FEB: "02",
	MAR: "03",
	APR: "04",
	MAY: "05",
	JUN: "06",
	JUL: "07",
	AUG: "08",
	SEP: "09",
	OCT: "10",
	NOV: "11",
	DEC: "12",
};

const AN_DT_RE = /^(\d{2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/;

function str(v: unknown): string | null {
	if (typeof v !== "string") return null;
	const t = v.trim();
	return t === "" ? null : t;
}

/**
 * "06-Aug-2026 22:04:15" → "2026-08-06T22:04:15+05:30".
 *
 * NSE publishes these in IST with no offset attached; the offset is applied
 * here rather than letting the runtime guess a local timezone.
 */
export function parseAnnouncementDate(value: unknown): string | null {
	const s = str(value);
	if (!s) return null;
	const m = AN_DT_RE.exec(s);
	if (!m) return null;
	const month = MONTHS[m[2].toUpperCase()];
	if (!month) return null;
	const iso = `${m[3]}-${month}-${m[1]}T${m[4]}:${m[5]}:${m[6]}+05:30`;
	return Number.isNaN(new Date(iso).getTime()) ? null : iso;
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

/** Maps the top-level array, skipping anything that is not an object. */
export function mapAnnouncements(raw: unknown, limit?: number): Announcement[] {
	if (!Array.isArray(raw)) return [];
	const mapped = raw
		.filter((r): r is RawAnnouncement => typeof r === "object" && r !== null)
		.map(mapAnnouncement);
	return typeof limit === "number" && limit >= 0 ? mapped.slice(0, limit) : mapped;
}

export type AnnouncementsResult = {
	announcements: Announcement[];
};

/** Fetch recent equity announcements straight from upstream. NSE returns ~20 per call. */
export async function fetchAnnouncements(): Promise<AnnouncementsResult> {
	const raw = await fetchJson<unknown>(NSE_ANNOUNCEMENTS_URL, {
		source: SOURCE,
		headers: { Referer: REFERER },
	});
	return { announcements: mapAnnouncements(raw) };
}

/**
 * Recent equity announcements, cached for 15 minutes.
 *
 * The full record set is cached and `limit` is applied on read, so callers
 * asking for different limits share one entry rather than fragmenting the key
 * space. Pass `store: null` to bypass caching.
 */
export async function getAnnouncements(
	store: CacheStore | null,
	opts: { limit?: number; now?: Date } = {},
): Promise<Cached<AnnouncementsResult>> {
	const now = opts.now ?? new Date();
	const result = await withCache(
		store,
		cacheKey.announcements(),
		TTL_DEFAULT_SECONDS,
		fetchAnnouncements,
		{ now },
	);
	if (typeof opts.limit !== "number" || opts.limit < 0) return result;
	return { ...result, announcements: result.announcements.slice(0, opts.limit) };
}
