import { afterEach, describe, expect, it, vi } from "vitest";
import { getIndices, INDEX_KEYS, NSE_INDICES } from "../src/data/indices";
import { mapQuote, type YahooChartResponse } from "../src/data/quotes";
import { fixture } from "./fixtures";

const nsei = fixture<YahooChartResponse>("yahoo-chart-nsei.json");
const nsebank = fixture<YahooChartResponse>("yahoo-chart-nsebank.json");

afterEach(() => vi.unstubAllGlobals());

describe("NSE_INDICES", () => {
	it("uses the Yahoo index tickers from DATA_SOURCES.md", () => {
		expect(NSE_INDICES.NIFTY_50.yahooSymbol).toBe("^NSEI");
		expect(NSE_INDICES.NIFTY_BANK.yahooSymbol).toBe("^NSEBANK");
		expect(INDEX_KEYS).toEqual(["NIFTY_50", "NIFTY_BANK"]);
	});
});

describe("index payloads map through the shared quote mapper", () => {
	it("maps ^NSEI", () => {
		const q = mapQuote(nsei, "^NSEI", "^NSEI");
		expect(q).toMatchObject({
			symbol: "^NSEI",
			name: "NIFTY 50",
			currency: "INR",
			price: 24636,
			previousClose: 24624.65,
			source: "yahoo-chart-v8",
		});
		expect(q.change).toBe(11.35);
		expect(q.changePercent).toBe(0.05);
	});

	it("maps ^NSEBANK", () => {
		const q = mapQuote(nsebank, "^NSEBANK", "^NSEBANK");
		expect(q.symbol).toBe("^NSEBANK");
		expect(q.name).toMatch(/BANK/i);
		expect(typeof q.price).toBe("number");
		expect(q.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it("keeps index volume as reported (0 is not missing data)", () => {
		expect(mapQuote(nsei, "^NSEI", "^NSEI").volume).toBe(0);
	});
});

describe("getIndices", () => {
	/** Serve each index from its fixture; optionally fail one with a status. */
	function stubYahoo(failSymbol?: string, status = 503) {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				const isBank = url.includes("%5ENSEBANK");
				const symbol = isBank ? "^NSEBANK" : "^NSEI";
				if (symbol === failSymbol) return new Response("upstream down", { status });
				return new Response(JSON.stringify(isBank ? nsebank : nsei), { status: 200 });
			}),
		);
	}

	it("returns both indices when both sources answer", async () => {
		stubYahoo();
		const { indices, errors } = await getIndices(null);
		expect(errors).toEqual([]);
		expect(indices.map((i) => i.key)).toEqual(["NIFTY_50", "NIFTY_BANK"]);
		expect(indices[0].label).toBe("NIFTY 50");
		expect(indices[1].label).toBe("NIFTY BANK");
	});

	it("returns the surviving index when the other fails", async () => {
		stubYahoo("^NSEBANK");
		const { indices, errors } = await getIndices(null);
		expect(indices.map((i) => i.key)).toEqual(["NIFTY_50"]);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({ key: "NIFTY_BANK", code: "SOURCE_UNAVAILABLE" });
	});

	it("reports NOT_FOUND distinctly from an outage", async () => {
		stubYahoo("^NSEBANK", 404);
		const { errors } = await getIndices(null);
		expect(errors[0]).toMatchObject({ key: "NIFTY_BANK", code: "NOT_FOUND" });
	});
});
