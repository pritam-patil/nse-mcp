import { describe, expect, it } from "vitest";
import type { Cached, IndicesResult, MarketStatus, Quote } from "../src/data";
import { mapMarketStatus } from "../src/data/status";
import { mapQuote, type YahooChartResponse } from "../src/data/quotes";
import { formatIndices, formatMarketStatus, formatQuote, istTimestamp } from "../src/format";
import { fixture } from "./fixtures";

const reliance = fixture<YahooChartResponse>("yahoo-chart-reliance.json");
const nsei = fixture<YahooChartResponse>("yahoo-chart-nsei.json");
const nsebank = fixture<YahooChartResponse>("yahoo-chart-nsebank.json");
const rawStatus = fixture("nse-market-status.json");

/** Add cache metadata the way withCache would. */
function cached<T extends object>(data: T, meta?: Partial<Cached<T>>): Cached<T> {
	return { ...data, stale: false, cachedAt: "2026-08-06T10:00:00.000Z", ...meta };
}

describe("istTimestamp", () => {
	it("renders UTC ISO as an IST wall-clock string", () => {
		// 04:25:05 UTC + 5:30 = 09:55 IST.
		expect(istTimestamp("2026-08-06T04:25:05.000Z")).toBe("06-Aug-2026 09:55 IST");
	});

	it("rolls the date forward when the offset crosses midnight", () => {
		expect(istTimestamp("2026-08-06T18:45:00.000Z")).toBe("07-Aug-2026 00:15 IST");
	});

	it.each([null, undefined, "", "not-a-date"])("returns null for %j", (v) => {
		expect(istTimestamp(v)).toBeNull();
	});
});

describe("formatQuote", () => {
	const quote = cached(mapQuote(reliance, "RELIANCE", "RELIANCE.NS"));
	const text = formatQuote(quote);

	it("is compact label:value text, not JSON", () => {
		expect(text).not.toContain("{");
		expect(text).not.toContain('"');
	});

	it("leads with the symbol and company name", () => {
		expect(text.split("\n")[0]).toBe("RELIANCE — Reliance Industries Limited, NSE");
	});

	it("renders price, change, ranges and grouped volume", () => {
		expect(text).toContain("Price: 1,325.00 INR");
		expect(text).toContain("Change: +45.00 (+3.52%)");
		expect(text).toContain("Prev close: 1,280.00");
		expect(text).toContain("Day range: 1,281.20–1,325.20");
		expect(text).toContain("52-week range: 1,249.80–1,611.80");
		expect(text).toContain("Volume: 20,203,425");
	});

	it("ends with an IST as-of line derived from the market time", () => {
		const last = text.split("\n").at(-1)!;
		expect(last).toBe("as of 06-Aug-2026 15:15 IST");
	});

	it("marks stale data and still ends with as-of", () => {
		const t = formatQuote(
			cached(mapQuote(reliance, "RELIANCE", "RELIANCE.NS"), { stale: true }),
		);
		expect(t).toContain("Note: stale");
		expect(t.split("\n").at(-1)).toMatch(/^as of /);
	});

	it("shows n/a for a missing price and omits absent fields", () => {
		const sparse: Cached<Quote> = cached({
			symbol: "X",
			yahooSymbol: "X.NS",
			name: null,
			currency: null,
			exchange: null,
			price: null,
			previousClose: null,
			change: null,
			changePercent: null,
			dayHigh: null,
			dayLow: null,
			volume: null,
			fiftyTwoWeekHigh: null,
			fiftyTwoWeekLow: null,
			asOf: null,
			source: "yahoo-chart-v8",
		});
		const t = formatQuote(sparse);
		expect(t).toContain("Price: n/a");
		expect(t).not.toContain("Change:");
		expect(t).not.toContain("Volume:");
		// Falls back to cachedAt for the as-of line when asOf is null.
		expect(t.split("\n").at(-1)).toBe("as of 06-Aug-2026 15:30 IST");
	});

	it("does not print a negative change without a sign", () => {
		const q = cached(
			mapQuote(
				{ chart: { result: [{ meta: { regularMarketPrice: 90, previousClose: 100 } }] } },
				"X",
				"X.NS",
			),
		);
		const t = formatQuote(q);
		expect(t).toContain("Change: -10.00 (-10.00%)");
	});
});

describe("formatIndices", () => {
	const nifty = {
		...mapQuote(nsei, "^NSEI", "^NSEI"),
		key: "NIFTY_50" as const,
		label: "NIFTY 50",
	};
	const bank = {
		...mapQuote(nsebank, "^NSEBANK", "^NSEBANK"),
		key: "NIFTY_BANK" as const,
		label: "NIFTY BANK",
	};

	it("renders one line per index with change", () => {
		const t = formatIndices(cached<IndicesResult>({ indices: [nifty, bank], errors: [] }));
		expect(t).toContain("NIFTY 50: 24,636.00 +11.35 (+0.05%)");
		expect(t).toContain("NIFTY BANK:");
		expect(t.split("\n").at(-1)).toMatch(/^as of .* IST$/);
	});

	it("notes an unavailable index without failing the whole call", () => {
		const t = formatIndices(
			cached<IndicesResult>({
				indices: [nifty],
				errors: [{ key: "NIFTY_BANK", code: "SOURCE_UNAVAILABLE", message: "down" }],
			}),
		);
		expect(t).toContain("NIFTY 50: 24,636.00");
		expect(t).toContain("NIFTY BANK: unavailable (SOURCE_UNAVAILABLE)");
	});

	it("uses the latest per-index timestamp as the as-of", () => {
		const t = formatIndices(cached<IndicesResult>({ indices: [nifty, bank], errors: [] }));
		// nsei asOf is 10:01:18 UTC → 15:31 IST; nsebank shares that minute.
		expect(t.split("\n").at(-1)).toBe("as of 06-Aug-2026 15:31 IST");
	});

	it("handles a fully empty result", () => {
		const t = formatIndices(cached<IndicesResult>({ indices: [], errors: [] }));
		expect(t).toContain("No index data available.");
		expect(t.split("\n").at(-1)).toMatch(/^as of /);
	});
});

describe("formatMarketStatus", () => {
	const status = cached(mapMarketStatus(rawStatus) as MarketStatus);
	const text = formatMarketStatus(status);

	it("leads with the headline open/closed state", () => {
		expect(text.split("\n")[0]).toBe("NSE market: CLOSED");
	});

	it("shows the Capital Market segment with its message", () => {
		expect(text).toContain("Capital Market: Closed — Normal Market has Closed");
	});

	it("shows the headline index level", () => {
		expect(text).toContain("NIFTY 50: 24,636.00 (+0.05%)");
	});

	it("summarises the other segments, including a divergent one", () => {
		const line = text.split("\n").find((l) => l.startsWith("Other segments:"))!;
		expect(line).toContain("Commodity Open");
		expect(line).toContain("Currency Closed");
	});

	it("uses the trade date as the IST as-of", () => {
		expect(text.split("\n").at(-1)).toBe("as of 06-Aug-2026 15:30 IST");
	});

	it("is not raw JSON", () => {
		expect(text).not.toContain("{");
		expect(text).not.toContain("marketState");
	});
});
