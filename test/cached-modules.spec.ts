/** Caching behaviour of the data modules themselves, with `fetch` stubbed. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheKey, type CacheStore } from "../src/data/cache";
import { getAnnouncements } from "../src/data/announcements";
import { getIndices } from "../src/data/indices";
import { getQuote } from "../src/data/quotes";
import { getMarketStatus } from "../src/data/status";
import { fixture } from "./fixtures";

const reliance = fixture("yahoo-chart-reliance.json");
const nsei = fixture("yahoo-chart-nsei.json");
const nsebank = fixture("yahoo-chart-nsebank.json");
const marketStatus = fixture("nse-market-status.json");
const announcements = fixture("nse-announcements.json");

/** Mid-session on Monday 2026-08-03, so quote TTL is the 60s in-hours value. */
const DURING_HOURS = new Date("2026-08-03T12:00:00+05:30");
/** Monday evening, outside NSE hours. */
const OFF_HOURS = new Date("2026-08-03T20:00:00+05:30");

function memoryStore() {
	const data = new Map<string, string>();
	const store: CacheStore = {
		get: async (key) => data.get(key) ?? null,
		put: async (key, value) => void data.set(key, value),
	};
	return { store, data };
}

/** Serve fixtures by URL; `fail` makes every matching request throw. */
function stubFetch(fail: string | null = null) {
	const fn = vi.fn(async (url: string) => {
		if (fail && url.includes(fail)) throw new TypeError("network down");
		if (url.includes("%5ENSEBANK")) return new Response(JSON.stringify(nsebank));
		if (url.includes("%5ENSEI")) return new Response(JSON.stringify(nsei));
		if (url.includes("RELIANCE")) return new Response(JSON.stringify(reliance));
		if (url.includes("marketStatus")) return new Response(JSON.stringify(marketStatus));
		if (url.includes("corporate-announcements")) {
			return new Response(JSON.stringify(announcements));
		}
		throw new Error(`unstubbed url: ${url}`);
	});
	vi.stubGlobal("fetch", fn);
	return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("getQuote", () => {
	it("writes to the documented key format", async () => {
		const { store, data } = memoryStore();
		stubFetch();
		await getQuote(store, "RELIANCE", DURING_HOURS);
		expect([...data.keys()]).toEqual([cacheKey.quote("RELIANCE")]);
		expect([...data.keys()][0]).toBe("v1:quote:RELIANCE");
	});

	it("normalises the symbol into the key, so RELIANCE.NS shares one entry", async () => {
		const { store, data } = memoryStore();
		const fn = stubFetch();
		await getQuote(store, "reliance", DURING_HOURS);
		await getQuote(store, "RELIANCE.NS", DURING_HOURS);
		expect([...data.keys()]).toEqual(["v1:quote:RELIANCE"]);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("serves the second call from cache within the 60s in-hours TTL", async () => {
		const { store } = memoryStore();
		const fn = stubFetch();
		await getQuote(store, "RELIANCE", DURING_HOURS);
		const second = await getQuote(store, "RELIANCE", new Date(DURING_HOURS.getTime() + 30_000));
		expect(fn).toHaveBeenCalledTimes(1);
		expect(second.stale).toBe(false);
		expect(second.price).toBe(1325);
	});

	it("refetches after 60s during market hours", async () => {
		const { store } = memoryStore();
		const fn = stubFetch();
		await getQuote(store, "RELIANCE", DURING_HOURS);
		await getQuote(store, "RELIANCE", new Date(DURING_HOURS.getTime() + 61_000));
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("holds the entry for 15 minutes outside market hours", async () => {
		const { store } = memoryStore();
		const fn = stubFetch();
		await getQuote(store, "RELIANCE", OFF_HOURS);
		// Still cached at 10 minutes, refetched past 15.
		await getQuote(store, "RELIANCE", new Date(OFF_HOURS.getTime() + 10 * 60_000));
		expect(fn).toHaveBeenCalledTimes(1);
		await getQuote(store, "RELIANCE", new Date(OFF_HOURS.getTime() + 16 * 60_000));
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("serves the last value with stale: true when Yahoo fails", async () => {
		const { store } = memoryStore();
		stubFetch();
		await getQuote(store, "RELIANCE", DURING_HOURS);

		stubFetch("RELIANCE");
		const stale = await getQuote(store, "RELIANCE", new Date(DURING_HOURS.getTime() + 120_000));

		expect(stale.stale).toBe(true);
		expect(stale.price).toBe(1325);
		expect(stale.cachedAt).toBe(DURING_HOURS.toISOString());
	});

	it("rejects an invalid symbol before touching the cache", async () => {
		const get = vi.fn(async () => null);
		const store: CacheStore = { get, put: async () => {} };
		await expect(getQuote(store, "not a symbol", DURING_HOURS)).rejects.toThrow();
		expect(get).not.toHaveBeenCalled();
	});
});

describe("getMarketStatus", () => {
	it("caches under v1:status and serves stale on failure", async () => {
		const { store, data } = memoryStore();
		stubFetch();
		const fresh = await getMarketStatus(store, OFF_HOURS);
		expect([...data.keys()]).toEqual(["v1:status"]);
		expect(fresh.stale).toBe(false);
		expect(fresh.status).toBe("closed");

		stubFetch("marketStatus");
		const stale = await getMarketStatus(store, new Date(OFF_HOURS.getTime() + 60 * 60_000));
		expect(stale.stale).toBe(true);
		expect(stale.status).toBe("closed");
		expect(stale.segments.length).toBeGreaterThan(0);
	});
});

describe("getAnnouncements", () => {
	it("caches the full set for 15 minutes and applies limit on read", async () => {
		const { store, data } = memoryStore();
		const fn = stubFetch();

		const all = await getAnnouncements(store, { now: OFF_HOURS });
		expect(all.announcements).toHaveLength(20);
		expect([...data.keys()]).toEqual(["v1:announcements:equities"]);

		// A different limit must reuse the same entry rather than refetch.
		const five = await getAnnouncements(store, {
			limit: 5,
			now: new Date(OFF_HOURS.getTime() + 60_000),
		});
		expect(five.announcements).toHaveLength(5);
		expect(fn).toHaveBeenCalledTimes(1);

		await getAnnouncements(store, { now: new Date(OFF_HOURS.getTime() + 16 * 60_000) });
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("serves stale with the limit still applied", async () => {
		const { store } = memoryStore();
		stubFetch();
		await getAnnouncements(store, { now: OFF_HOURS });

		stubFetch("corporate-announcements");
		const stale = await getAnnouncements(store, {
			limit: 3,
			now: new Date(OFF_HOURS.getTime() + 60 * 60_000),
		});
		expect(stale.stale).toBe(true);
		expect(stale.announcements).toHaveLength(3);
	});
});

describe("getIndices", () => {
	it("caches the pair under v1:indices for 15 minutes", async () => {
		const { store, data } = memoryStore();
		const fn = stubFetch();

		const first = await getIndices(store, OFF_HOURS);
		expect(first.indices.map((i) => i.key)).toEqual(["NIFTY_50", "NIFTY_BANK"]);
		expect([...data.keys()]).toEqual(["v1:indices"]);
		expect(fn).toHaveBeenCalledTimes(2); // one per index

		await getIndices(store, new Date(OFF_HOURS.getTime() + 10 * 60_000));
		expect(fn).toHaveBeenCalledTimes(2); // served from cache
	});

	it("does not cache a partial result", async () => {
		const { store, data } = memoryStore();
		stubFetch("%5ENSEBANK");

		const result = await getIndices(store, OFF_HOURS);

		expect(result.indices.map((i) => i.key)).toEqual(["NIFTY_50"]);
		expect(result.errors).toHaveLength(1);
		expect([...data.keys()]).toEqual([]);
	});

	it("prefers a cached complete pair over a fresh partial one", async () => {
		const { store } = memoryStore();
		stubFetch();
		await getIndices(store, OFF_HOURS);

		stubFetch("%5ENSEBANK");
		const later = await getIndices(store, new Date(OFF_HOURS.getTime() + 60 * 60_000));

		expect(later.stale).toBe(true);
		expect(later.indices.map((i) => i.key)).toEqual(["NIFTY_50", "NIFTY_BANK"]);
		expect(later.errors).toHaveLength(0);
	});

	it("serves stale when both indices fail", async () => {
		const { store } = memoryStore();
		stubFetch();
		await getIndices(store, OFF_HOURS);

		stubFetch("query1.finance.yahoo.com");
		const stale = await getIndices(store, new Date(OFF_HOURS.getTime() + 60 * 60_000));

		expect(stale.stale).toBe(true);
		expect(stale.indices).toHaveLength(2);
	});
});
