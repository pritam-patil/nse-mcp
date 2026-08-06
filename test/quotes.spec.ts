import { describe, expect, it } from "vitest";
import { DataError } from "../src/data/http";
import {
	epochSecondsToIso,
	mapQuote,
	normalizeSymbol,
	toYahooSymbol,
	type YahooChartResponse,
} from "../src/data/quotes";
import { fixture } from "./fixtures";

const reliance = fixture<YahooChartResponse>("yahoo-chart-reliance.json");
const notFound = fixture<YahooChartResponse>("yahoo-chart-notfound.json");

describe("normalizeSymbol", () => {
	it("uppercases and trims", () => {
		expect(normalizeSymbol(" reliance ")).toBe("RELIANCE");
	});

	it("strips a caller-supplied .NS suffix", () => {
		expect(normalizeSymbol("RELIANCE.NS")).toBe("RELIANCE");
		expect(normalizeSymbol("infy.ns")).toBe("INFY");
	});

	it("allows & and - which real NSE symbols use", () => {
		expect(normalizeSymbol("M&M")).toBe("M&M");
		expect(normalizeSymbol("BAJAJ-AUTO")).toBe("BAJAJ-AUTO");
	});

	it.each(["", "   ", "RELIANCE INDUSTRIES", "../etc/passwd", "A".repeat(21)])(
		"rejects %j as NOT_FOUND",
		(input) => {
			expect(() => normalizeSymbol(input)).toThrowError(DataError);
			try {
				normalizeSymbol(input);
			} catch (err) {
				expect((err as DataError).code).toBe("NOT_FOUND");
			}
		},
	);
});

describe("toYahooSymbol", () => {
	it("appends .NS to equities", () => {
		expect(toYahooSymbol("RELIANCE")).toBe("RELIANCE.NS");
	});

	it("leaves index tickers alone", () => {
		expect(toYahooSymbol("^NSEI")).toBe("^NSEI");
		expect(toYahooSymbol("^NSEBANK")).toBe("^NSEBANK");
	});
});

describe("epochSecondsToIso", () => {
	it("treats the value as seconds, not milliseconds", () => {
		expect(epochSecondsToIso(1786009505)).toBe("2026-08-06T09:45:05.000Z");
	});

	it.each([null, undefined, 0, -1, "abc", Number.NaN])("returns null for %j", (v) => {
		expect(epochSecondsToIso(v)).toBeNull();
	});
});

describe("mapQuote — real RELIANCE.NS response", () => {
	const quote = mapQuote(reliance, "RELIANCE", "RELIANCE.NS");

	it("keeps the plain symbol for callers and records what was sent upstream", () => {
		expect(quote.symbol).toBe("RELIANCE");
		expect(quote.yahooSymbol).toBe("RELIANCE.NS");
	});

	it("maps every documented meta field", () => {
		expect(quote).toMatchObject({
			name: "Reliance Industries Limited",
			currency: "INR",
			exchange: "NSE",
			price: 1325,
			previousClose: 1280,
			dayHigh: 1325.2,
			dayLow: 1281.2,
			volume: 20203425,
			fiftyTwoWeekHigh: 1611.8,
			fiftyTwoWeekLow: 1249.8,
			source: "yahoo-chart-v8",
		});
	});

	it("derives change and percent from price vs previousClose", () => {
		expect(quote.change).toBe(45);
		expect(quote.changePercent).toBe(3.52);
	});

	it("converts regularMarketTime to ISO", () => {
		expect(quote.asOf).toBe("2026-08-06T09:45:05.000Z");
	});
});

describe("mapQuote — degraded payloads", () => {
	it("throws NOT_FOUND on Yahoo's unknown-symbol response", () => {
		expect(() => mapQuote(notFound, "NOTAREALSYM", "NOTAREALSYM.NS")).toThrowError(DataError);
		try {
			mapQuote(notFound, "NOTAREALSYM", "NOTAREALSYM.NS");
		} catch (err) {
			expect((err as DataError).code).toBe("NOT_FOUND");
			// Yahoo's own wording should survive into the message.
			expect((err as DataError).message).toMatch(/NOTAREALSYM/);
		}
	});

	it("throws NOT_FOUND when result is an empty array", () => {
		expect(() => mapQuote({ chart: { result: [] } }, "X", "X.NS")).toThrowError(DataError);
	});

	it("falls back to chartPreviousClose when previousClose is absent", () => {
		const q = mapQuote(
			{ chart: { result: [{ meta: { regularMarketPrice: 110, chartPreviousClose: 100 } }] } },
			"X",
			"X.NS",
		);
		expect(q.previousClose).toBe(100);
		expect(q.change).toBe(10);
		expect(q.changePercent).toBe(10);
	});

	it("nulls derived fields rather than inventing them when price is missing", () => {
		const q = mapQuote({ chart: { result: [{ meta: { previousClose: 100 } }] } }, "X", "X.NS");
		expect(q.price).toBeNull();
		expect(q.change).toBeNull();
		expect(q.changePercent).toBeNull();
	});

	it("does not divide by zero when previousClose is 0", () => {
		const q = mapQuote(
			{ chart: { result: [{ meta: { regularMarketPrice: 10, previousClose: 0 } }] } },
			"X",
			"X.NS",
		);
		expect(q.change).toBe(10);
		expect(q.changePercent).toBeNull();
	});

	it("prefers longName but accepts shortName alone", () => {
		const q = mapQuote(
			{ chart: { result: [{ meta: { shortName: "SHORT ONLY" } }] } },
			"X",
			"X.NS",
		);
		expect(q.name).toBe("SHORT ONLY");
	});
});
