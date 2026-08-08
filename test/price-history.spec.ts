import { afterEach, describe, expect, it, vi } from "vitest";
import { type CacheStore } from "../src/data/cache";
import { DataError } from "../src/data/http";
import {
	downsample,
	getPriceHistory,
	mapHistory,
	MAX_ROWS,
	validateRangeInterval,
	type OhlcRow,
	type PriceHistory,
} from "../src/data/price-history";
import { formatPriceHistory } from "../src/format";
import { fixture } from "./fixtures";

const daily = fixture("yahoo-chart-history-reliance-1mo.json");
const intraday = fixture("yahoo-chart-reliance.json"); // 1d @ 1m, 375 bars

function memoryStore() {
	const data = new Map<string, string>();
	const store: CacheStore = {
		get: async (k) => data.get(k) ?? null,
		put: async (k, v) => void data.set(k, v),
	};
	return { store, data };
}

function row(t: number): OhlcRow {
	return { t, open: t, high: t, low: t, close: t, volume: t };
}

describe("validateRangeInterval", () => {
	it("accepts a sensible combo", () => {
		expect(validateRangeInterval("1mo", "1d")).toEqual({ range: "1mo", interval: "1d" });
	});

	it("rejects an unknown range with the valid list", () => {
		expect(() => validateRangeInterval("7mo", "1d")).toThrowError(/invalid range/);
	});

	it("rejects an unknown interval", () => {
		expect(() => validateRangeInterval("1mo", "3m")).toThrowError(/invalid interval/);
	});

	it("rejects an over-long combo with a helpful message", () => {
		// 1-minute bars cannot span a year.
		expect(() => validateRangeInterval("1y", "1m")).toThrowError(
			/coarser interval|shorter range/,
		);
		try {
			validateRangeInterval("1y", "1m");
		} catch (err) {
			expect((err as DataError).code).toBe("NOT_FOUND");
		}
	});

	it("allows intraday for a short range", () => {
		expect(validateRangeInterval("5d", "1m")).toEqual({ range: "5d", interval: "1m" });
		expect(validateRangeInterval("1y", "1h")).toEqual({ range: "1y", interval: "1h" });
	});
});

describe("downsample", () => {
	it("leaves short series untouched", () => {
		const rows = [row(1), row(2), row(3)];
		expect(downsample(rows, 60)).toBe(rows);
	});

	it("caps to the max and keeps first and last", () => {
		const rows = Array.from({ length: 375 }, (_, i) => row(i));
		const out = downsample(rows, 60);
		expect(out).toHaveLength(60);
		expect(out[0].t).toBe(0);
		expect(out[out.length - 1].t).toBe(374);
	});

	it("returns evenly spaced, monotonically increasing timestamps", () => {
		const rows = Array.from({ length: 200 }, (_, i) => row(i * 10));
		const out = downsample(rows, 60);
		for (let i = 1; i < out.length; i++) expect(out[i].t).toBeGreaterThan(out[i - 1].t);
	});
});

describe("mapHistory — real daily response", () => {
	const h = mapHistory(daily, "RELIANCE", "RELIANCE.NS", "1mo", "1d");

	it("maps meta and OHLC rows", () => {
		expect(h.symbol).toBe("RELIANCE");
		expect(h.range).toBe("1mo");
		expect(h.interval).toBe("1d");
		expect(h.granularity).toBe("1d");
		expect(h.currency).toBe("INR");
		expect(h.intraday).toBe(false);
		expect(h.rows.length).toBeGreaterThan(0);
		expect(h.rows.length).toBeLessThanOrEqual(MAX_ROWS);
	});

	it("has complete OHLC in the first row", () => {
		const r = h.rows[0];
		expect(r.close).toBeCloseTo(1308.4, 1);
		for (const k of ["open", "high", "low", "close"] as const) {
			expect(typeof r[k]).toBe("number");
		}
	});

	it("does not downsample a 24-bar series", () => {
		expect(h.downsampledFrom).toBeNull();
	});
});

describe("mapHistory — intraday response downsamples", () => {
	const h = mapHistory(intraday, "RELIANCE", "RELIANCE.NS", "1d", "1m");

	it("caps the one-minute bars at MAX_ROWS and records the original count", () => {
		expect(h.rows).toHaveLength(MAX_ROWS);
		// 375 timestamps, minus bars with a null close.
		expect(h.downsampledFrom).toBe(361);
		expect(h.downsampledFrom).toBeGreaterThan(MAX_ROWS);
		expect(h.intraday).toBe(true);
	});
});

describe("mapHistory — validation & degraded", () => {
	it("rejects a range not in the response's validRanges", () => {
		const raw = {
			chart: {
				result: [
					{
						meta: { validRanges: ["1d", "5d"] },
						timestamp: [],
						indicators: { quote: [{}] },
					},
				],
			},
		};
		expect(() => mapHistory(raw, "X", "X.NS", "1mo", "1d")).toThrowError(/not available/);
	});

	it("throws NOT_FOUND when there is no result", () => {
		const raw = { chart: { result: null, error: { description: "No data found" } } };
		expect(() => mapHistory(raw, "X", "X.NS", "1mo", "1d")).toThrowError(DataError);
	});

	it("skips bars with a null close (holidays/halts)", () => {
		const raw = {
			chart: {
				result: [
					{
						meta: { validRanges: ["1mo"], dataGranularity: "1d" },
						timestamp: [1, 2, 3],
						indicators: {
							quote: [
								{
									open: [1, 2, 3],
									high: [1, 2, 3],
									low: [1, 2, 3],
									close: [10, null, 12],
									volume: [1, 2, 3],
								},
							],
						},
					},
				],
			},
		};
		const h = mapHistory(raw, "X", "X.NS", "1mo", "1d");
		expect(h.rows.map((r) => r.close)).toEqual([10, 12]);
	});
});

describe("getPriceHistory", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("normalises symbol, appends .NS in the request, caches under v1:history", async () => {
		const fn = vi.fn(async (_url: string) => new Response(JSON.stringify(daily)));
		vi.stubGlobal("fetch", fn);
		const { store, data } = memoryStore();

		const h = await getPriceHistory(store, "reliance", "1mo", "1d");
		expect(h.symbol).toBe("RELIANCE");
		expect([...data.keys()]).toEqual(["v1:history:RELIANCE:1mo:1d"]);
		const url = fn.mock.calls[0][0];
		expect(url).toContain("RELIANCE.NS");
		expect(url).toContain("range=1mo");
		expect(url).toContain("interval=1d");
	});

	it("accepts an index alias, querying ^NSEBANK without .NS", async () => {
		const fn = vi.fn(async (_url: string) => new Response(JSON.stringify(daily)));
		vi.stubGlobal("fetch", fn);
		const { store, data } = memoryStore();

		const h = await getPriceHistory(store, "NIFTY BANK", "6mo", "1d");
		expect(h.symbol).toBe("NIFTY BANK");
		expect([...data.keys()]).toEqual(["v1:history:NIFTY BANK:6mo:1d"]);
		const url = fn.mock.calls[0][0];
		expect(url).toContain("%5ENSEBANK"); // ^NSEBANK, URL-encoded
		expect(url).not.toContain(".NS");
	});

	it("defaults to 1mo/1d", async () => {
		const fn = vi.fn(async () => new Response(JSON.stringify(daily)));
		vi.stubGlobal("fetch", fn);
		const { data } = memoryStore();
		const store: CacheStore = {
			get: async (k) => data.get(k) ?? null,
			put: async (k, v) => void data.set(k, v),
		};
		await getPriceHistory(store, "RELIANCE");
		expect([...data.keys()]).toEqual(["v1:history:RELIANCE:1mo:1d"]);
	});

	it("rejects an over-long combo before fetching", async () => {
		const fn = vi.fn();
		vi.stubGlobal("fetch", fn);
		await expect(
			getPriceHistory(memoryStore().store, "RELIANCE", "5y", "1m"),
		).rejects.toThrowError(DataError);
		expect(fn).not.toHaveBeenCalled();
	});

	it("serves stale on upstream failure", async () => {
		const { store } = memoryStore();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(daily))),
		);
		await getPriceHistory(store, "RELIANCE", "1mo", "1d", new Date("2026-08-07T00:00:00Z"));

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("x", { status: 503 })),
		);
		const stale = await getPriceHistory(
			store,
			"RELIANCE",
			"1mo",
			"1d",
			new Date("2026-08-07T02:00:00Z"),
		);
		expect(stale.stale).toBe(true);
		expect(stale.rows.length).toBeGreaterThan(0);
	});
});

describe("formatPriceHistory", () => {
	const cached = (h: PriceHistory, stale = false) => ({
		...h,
		stale,
		cachedAt: "2026-08-07T00:00:00.000Z",
	});

	it("renders a header and one OHLC row per bar, ending with as-of", () => {
		const h = cached(mapHistory(daily, "RELIANCE", "RELIANCE.NS", "1mo", "1d"));
		const text = formatPriceHistory(h);
		const lines = text.split("\n");
		expect(lines[0]).toContain("RELIANCE — 1mo @ 1d");
		expect(lines[0]).toContain("INR");
		expect(lines[1]).toMatch(/^\d{2}-[A-Z][a-z]{2}-\d{4}\s+O \d/);
		expect(lines.at(-1)).toMatch(/^as of .* IST$/);
		expect(text).not.toContain("{");
	});

	it("notes downsampling in the header and shows intraday times", () => {
		const h = cached(mapHistory(intraday, "RELIANCE", "RELIANCE.NS", "1d", "1m"));
		const text = formatPriceHistory(h);
		expect(text).toContain("downsampled to 60");
		// Intraday rows carry a HH:MM time.
		expect(text.split("\n")[1]).toMatch(/\d{2}-[A-Z][a-z]{2}-\d{4} \d{2}:\d{2}\s+O /);
	});

	it("marks stale data", () => {
		const h = cached(mapHistory(daily, "RELIANCE", "RELIANCE.NS", "1mo", "1d"), true);
		expect(formatPriceHistory(h)).toContain("Note: stale");
	});
});
