/** get_announcements behaviour: symbol filtering, sorting, formatting, limits. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getAnnouncements,
	mapAnnouncements,
	type AnnouncementsResult,
} from "../src/data/announcements";
import { type CacheStore } from "../src/data/cache";
import { formatAnnouncements } from "../src/format";
import { fixture } from "./fixtures";

const allEquities = fixture<unknown[]>("nse-announcements.json");
const relianceRaw = fixture<unknown[]>("nse-announcements-reliance.json");

const OFF_HOURS = new Date("2026-08-07T20:00:00+05:30");

function memoryStore() {
	const data = new Map<string, string>();
	const store: CacheStore = {
		get: async (k) => data.get(k) ?? null,
		put: async (k, v) => void data.set(k, v),
	};
	return { store, data };
}

/** Route the two fixtures by whether the URL carries a symbol param. */
function stubFetch(fail = false) {
	const fn = vi.fn(async (url: string) => {
		if (fail) throw new TypeError("network down");
		const body = url.includes("symbol=") ? relianceRaw : allEquities;
		return new Response(JSON.stringify(body));
	});
	vi.stubGlobal("fetch", fn);
	return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("mapAnnouncements sorting", () => {
	it("returns records newest first", () => {
		const items = mapAnnouncements(relianceRaw);
		const iso = items.map((i) => i.announcedAtIso).filter(Boolean) as string[];
		expect(iso).toEqual([...iso].sort().reverse());
	});
});

describe("getAnnouncements — market-wide", () => {
	it("caches under v1:announcements:equities and applies the limit on read", async () => {
		const { store, data } = memoryStore();
		const fn = stubFetch();

		const all = await getAnnouncements(store, { now: OFF_HOURS });
		expect(all.announcements.length).toBe(20);
		expect([...data.keys()]).toEqual(["v1:announcements:equities"]);

		const five = await getAnnouncements(store, {
			limit: 5,
			now: new Date(OFF_HOURS.getTime() + 60_000),
		});
		expect(five.announcements).toHaveLength(5);
		expect(fn).toHaveBeenCalledTimes(1);
	});
});

describe("getAnnouncements — per symbol", () => {
	it("queries with a symbol + date window and caches under its own key", async () => {
		const { store, data } = memoryStore();
		const fn = stubFetch();

		const result = await getAnnouncements(store, { symbol: "reliance", now: OFF_HOURS });

		expect(result.announcements.length).toBeGreaterThan(20);
		expect([...data.keys()]).toEqual(["v1:announcements:sym:RELIANCE"]);
		const url = fn.mock.calls[0][0] as string;
		expect(url).toContain("symbol=RELIANCE");
		expect(url).toMatch(/from_date=\d{2}-\d{2}-\d{4}/);
		expect(url).toMatch(/to_date=07-08-2026/);
	});

	it("does not fetch or throw for an invalid symbol", async () => {
		const fn = stubFetch();
		const result = await getAnnouncements(memoryStore().store, {
			symbol: "not valid",
			now: OFF_HOURS,
		});
		expect(result.announcements).toEqual([]);
		expect(fn).not.toHaveBeenCalled();
	});

	it("serves stale on upstream failure once seeded", async () => {
		const { store } = memoryStore();
		stubFetch();
		await getAnnouncements(store, { symbol: "RELIANCE", now: OFF_HOURS });

		stubFetch(true);
		const stale = await getAnnouncements(store, {
			symbol: "RELIANCE",
			limit: 3,
			now: new Date(OFF_HOURS.getTime() + 60 * 60_000),
		});
		expect(stale.stale).toBe(true);
		expect(stale.announcements).toHaveLength(3);
	});
});

describe("formatAnnouncements", () => {
	const cached = (
		data: AnnouncementsResult,
		stale = false,
	): typeof data & {
		stale: boolean;
		cachedAt: string | null;
	} => ({ ...data, stale, cachedAt: "2026-08-07T00:00:00.000Z" });

	it("renders date — headline with an indented link, newest first", () => {
		const items = mapAnnouncements(relianceRaw, 2);
		const text = formatAnnouncements(cached({ announcements: items }), { symbol: "RELIANCE" });
		const lines = text.split("\n");
		expect(lines[0]).toMatch(/^07-Aug-2026 \d{2}:\d{2} IST — /);
		expect(lines[1].trim()).toMatch(/^https:\/\/nsearchives\.nseindia\.com\//);
	});

	it("prefixes the symbol in market-wide (no-symbol) mode", () => {
		const items = mapAnnouncements(allEquities, 1);
		const text = formatAnnouncements(cached({ announcements: items }));
		expect(text).toMatch(/— [A-Z0-9&-]+: /);
	});

	it("gives a friendly per-symbol message when empty", () => {
		expect(formatAnnouncements(cached({ announcements: [] }), { symbol: "reliance" })).toBe(
			"No recent announcements for RELIANCE.",
		);
	});

	it("gives a friendly market-wide message when empty", () => {
		expect(formatAnnouncements(cached({ announcements: [] }))).toBe("No recent announcements.");
	});

	it("marks stale data", () => {
		const items = mapAnnouncements(relianceRaw, 1);
		expect(formatAnnouncements(cached({ announcements: items }, true))).toContain(
			"Note: stale",
		);
	});
});
