import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheKey, type CacheStore } from "../src/data/cache";
import { DataError } from "../src/data/http";
import {
	getSymbolMatches,
	loadSymbols,
	parseEquityCsv,
	refreshSymbols,
	searchSymbols,
	type SymbolEntry,
} from "../src/data/symbols";
import { formatSymbolMatches } from "../src/format";
import { fixtureText } from "./fixtures";

const csv = fixtureText("equity-l-sample.csv");
const entries = parseEquityCsv(csv);

/** Symbols returned by a search, for terse assertions. */
function syms(results: SymbolEntry[]): string[] {
	return results.map((r) => r.symbol);
}

function memoryStore(seed?: string) {
	const data = new Map<string, string>();
	if (seed !== undefined) data.set(cacheKey.symbols(), seed);
	const puts: Array<{ key: string; value: string }> = [];
	const store: CacheStore = {
		get: async (key) => data.get(key) ?? null,
		put: async (key, value) => {
			data.set(key, value);
			puts.push({ key, value });
		},
	};
	return { store, data, puts };
}

describe("parseEquityCsv", () => {
	it("skips the header and parses symbol + company name", () => {
		expect(entries.length).toBe(18);
		expect(entries).toContainEqual({ symbol: "RELIANCE", name: "Reliance Industries Limited" });
	});

	it("preserves symbols with & and - ", () => {
		expect(entries).toContainEqual({ symbol: "M&M", name: "Mahindra & Mahindra Limited" });
		expect(entries).toContainEqual({ symbol: "BAJAJ-AUTO", name: "Bajaj Auto Limited" });
	});

	it("ignores blank lines and rows missing a field", () => {
		const messy = "SYMBOL,NAME\nAAA,Alpha Ltd\n\n,Nameless\nBBB,\nCCC,Gamma Ltd\n";
		expect(parseEquityCsv(messy)).toEqual([
			{ symbol: "AAA", name: "Alpha Ltd" },
			{ symbol: "CCC", name: "Gamma Ltd" },
		]);
	});

	it("handles a quoted field containing a comma", () => {
		const quoted = 'SYMBOL,NAME\nXYZ,"Xyz Foods, Beverages Ltd",EQ\n';
		expect(parseEquityCsv(quoted)).toEqual([
			{ symbol: "XYZ", name: "Xyz Foods, Beverages Ltd" },
		]);
	});
});

describe("searchSymbols — exact and substring", () => {
	it("returns the exact symbol first", () => {
		expect(searchSymbols(entries, "RELIANCE")[0].symbol).toBe("RELIANCE");
	});

	it("is case-insensitive", () => {
		expect(searchSymbols(entries, "reliance")[0].symbol).toBe("RELIANCE");
		expect(searchSymbols(entries, "ReLiAnCe")[0].symbol).toBe("RELIANCE");
	});

	it("matches a company-name word", () => {
		expect(syms(searchSymbols(entries, "infosys"))).toContain("INFY");
		expect(syms(searchSymbols(entries, "paints"))).toContain("ASIANPAINT");
	});

	it("matches a partial symbol prefix", () => {
		expect(searchSymbols(entries, "HDFC")[0].symbol).toBe("HDFCBANK");
		expect(searchSymbols(entries, "baj")[0].symbol.startsWith("BAJ")).toBe(true);
	});

	it("ranks a symbol prefix above a mere name substring", () => {
		// ITC's symbol starts with "it"; many company names merely contain "it"
		// (inside "Limited"), so ITC must come first.
		expect(searchSymbols(entries, "it")[0].symbol).toBe("ITC");
	});

	it("finds companies by a shared word and caps at the limit", () => {
		const tata = searchSymbols(entries, "tata");
		expect(syms(tata)).toEqual(expect.arrayContaining(["TCS", "TATAPOWER", "TATASTEEL"]));
		expect(searchSymbols(entries, "limited", 5).length).toBe(5);
	});

	it("matches names containing an ampersand", () => {
		expect(syms(searchSymbols(entries, "larsen"))).toContain("LT");
		expect(syms(searchSymbols(entries, "mahindra"))).toContain("M&M");
	});

	it("returns nothing for an empty or whitespace query", () => {
		expect(searchSymbols(entries, "")).toEqual([]);
		expect(searchSymbols(entries, "   ")).toEqual([]);
	});

	it("returns nothing for a query that matches nothing", () => {
		expect(searchSymbols(entries, "zzzzznomatch")).toEqual([]);
	});
});

describe("searchSymbols — fuzzy", () => {
	it("tolerates a transposition/typo in the symbol", () => {
		expect(syms(searchSymbols(entries, "relaince"))).toContain("RELIANCE");
	});

	it("tolerates a typo in a company name word", () => {
		expect(syms(searchSymbols(entries, "infosis"))).toContain("INFY");
	});

	it("keeps exact matches ahead of fuzzy ones", () => {
		// "wipro" is exact for WIPRO; nothing else should outrank it.
		expect(searchSymbols(entries, "wipro")[0].symbol).toBe("WIPRO");
	});
});

describe("loadSymbols", () => {
	it("returns [] when nothing is stored", async () => {
		expect(await loadSymbols(memoryStore().store)).toEqual([]);
	});

	it("returns [] for a corrupt entry", async () => {
		expect(await loadSymbols(memoryStore("not json").store)).toEqual([]);
	});

	it("returns [] for an unknown envelope version", async () => {
		const seed = JSON.stringify({ v: 2, symbols: [["A", "Alpha"]] });
		expect(await loadSymbols(memoryStore(seed).store)).toEqual([]);
	});

	it("round-trips symbols stored by refreshSymbols", async () => {
		const seed = JSON.stringify({
			v: 1,
			storedAt: "2026-08-07T00:00:00.000Z",
			count: 2,
			symbols: [
				["RELIANCE", "Reliance Industries Limited"],
				["TCS", "Tata Consultancy Services Limited"],
			],
		});
		const loaded = await loadSymbols(memoryStore(seed).store);
		expect(loaded).toHaveLength(2);
		expect(loaded[0]).toEqual({ symbol: "RELIANCE", name: "Reliance Industries Limited" });
	});
});

describe("getSymbolMatches", () => {
	it("loads from KV and searches", async () => {
		const seed = JSON.stringify({
			v: 1,
			storedAt: "2026-08-07T00:00:00.000Z",
			count: entries.length,
			symbols: entries.map((e) => [e.symbol, e.name]),
		});
		const { matches, updatedAt } = await getSymbolMatches(memoryStore(seed).store, "reliance");
		expect(matches[0].symbol).toBe("RELIANCE");
		// The list's refresh time travels with the result for the as-of line.
		expect(updatedAt).toBe("2026-08-07T00:00:00.000Z");
	});

	it("returns empty matches and null updatedAt when the list is unpopulated", async () => {
		const { matches, updatedAt } = await getSymbolMatches(memoryStore().store, "reliance");
		expect(matches).toEqual([]);
		expect(updatedAt).toBeNull();
	});
});

describe("refreshSymbols", () => {
	afterEach(() => vi.unstubAllGlobals());

	/** A CSV large enough to pass the sanity floor. */
	function bigCsv(rows: number): string {
		const lines = ["SYMBOL,NAME OF COMPANY,SERIES"];
		for (let i = 0; i < rows; i++) lines.push(`SYM${i},Company ${i} Limited,EQ`);
		return lines.join("\n");
	}

	it("fetches, parses, and stores under v1:symbols", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(bigCsv(150))),
		);
		const { store, data, puts } = memoryStore();

		const result = await refreshSymbols(store, new Date("2026-08-07T00:00:00.000Z"));

		expect(result.count).toBe(150);
		expect(puts).toHaveLength(1);
		expect(puts[0].key).toBe("v1:symbols");
		const stored = JSON.parse(data.get("v1:symbols")!);
		expect(stored.v).toBe(1);
		expect(stored.count).toBe(150);
		expect(stored.storedAt).toBe("2026-08-07T00:00:00.000Z");
		expect(stored.symbols[0]).toEqual(["SYM0", "Company 0 Limited"]);
	});

	it("throws and does not overwrite when the download is implausibly small", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(csv)),
		); // 18 rows < floor
		const { store, puts } = memoryStore();
		await expect(refreshSymbols(store)).rejects.toBeInstanceOf(DataError);
		expect(puts).toHaveLength(0);
	});

	it("propagates a download failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("nope", { status: 503 })),
		);
		const { puts } = memoryStore();
		await expect(refreshSymbols(memoryStore().store)).rejects.toBeInstanceOf(DataError);
		expect(puts).toHaveLength(0);
	});
});

describe("formatSymbolMatches", () => {
	it("renders SYMBOL — Company Name lines and an as-of from the list date", () => {
		const text = formatSymbolMatches(
			[
				{ symbol: "RELIANCE", name: "Reliance Industries Limited" },
				{ symbol: "TCS", name: "Tata Consultancy Services Limited" },
			],
			"reliance",
			"2026-08-07T00:00:00.000Z",
		);
		const lines = text.split("\n");
		expect(lines[0]).toBe("RELIANCE — Reliance Industries Limited");
		expect(lines[1]).toBe("TCS — Tata Consultancy Services Limited");
		expect(lines.at(-1)).toBe("as of 07-Aug-2026 05:30 IST");
	});

	it("caps output at 25 items", () => {
		const many = Array.from({ length: 40 }, (_, i) => ({ symbol: `SYM${i}`, name: `Co ${i}` }));
		const rows = formatSymbolMatches(many, "sym", "2026-08-07T00:00:00.000Z").split("\n");
		// 25 matches + 1 as-of line.
		expect(rows).toHaveLength(26);
	});

	it("reports no matches with the query echoed back", () => {
		const text = formatSymbolMatches([], "zzz");
		expect(text.split("\n")[0]).toBe('No NSE symbols match "zzz".');
		expect(text).toContain("as of");
	});

	it("is not JSON", () => {
		const text = formatSymbolMatches([{ symbol: "INFY", name: "Infosys Limited" }], "infy");
		expect(text).not.toContain("{");
	});
});
