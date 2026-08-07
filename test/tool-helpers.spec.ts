import { describe, expect, it } from "vitest";
import { DataError } from "../src/data/http";
import { normalizeSymbol } from "../src/data/quotes";
import { capText, clampLimit, DISCLAIMER, humanizeError, MAX_LIST } from "../src/tool-helpers";

describe("normalizeSymbol — hardened charset [A-Z0-9&-]{1,20}", () => {
	it("uppercases and strips a .NS suffix", () => {
		expect(normalizeSymbol(" reliance.ns ")).toBe("RELIANCE");
	});

	it("accepts & and -", () => {
		expect(normalizeSymbol("m&m")).toBe("M&M");
		expect(normalizeSymbol("bajaj-auto")).toBe("BAJAJ-AUTO");
	});

	it("rejects underscore (no longer allowed)", () => {
		expect(() => normalizeSymbol("FOO_BAR")).toThrowError(DataError);
	});

	it.each([
		"",
		"   ",
		"has space",
		"TOOOOOOOOOOOOOOOOOOOONG21",
		"semi;colon",
		"dot.dot",
		"^NSEI",
	])("rejects %j", (bad) => {
		expect(() => normalizeSymbol(bad)).toThrowError(DataError);
	});

	it("accepts a 20-char symbol but not 21", () => {
		expect(normalizeSymbol("A".repeat(20))).toBe("A".repeat(20));
		expect(() => normalizeSymbol("A".repeat(21))).toThrowError(DataError);
	});
});

describe("clampLimit", () => {
	it("applies the default for missing/invalid input", () => {
		expect(clampLimit(undefined, 10, 25)).toBe(10);
		expect(clampLimit(Number.NaN, 10, 25)).toBe(10);
	});

	it("caps at the max and floors at 1", () => {
		expect(clampLimit(1000, 10, 25)).toBe(25);
		expect(clampLimit(0, 10, 25)).toBe(1);
		expect(clampLimit(-5, 10, 25)).toBe(1);
	});

	it("truncates fractional limits", () => {
		expect(clampLimit(3.9, 10, 25)).toBe(3);
	});

	it("MAX_LIST is 25", () => {
		expect(MAX_LIST).toBe(25);
	});
});

describe("humanizeError", () => {
	const de = (code: "NOT_FOUND" | "TIMEOUT" | "SOURCE_UNAVAILABLE", msg: string) =>
		new DataError(code, msg, { source: "test" });

	it("gives a friendly line for timeouts", () => {
		expect(humanizeError(de("TIMEOUT", "test: timed out after 5000ms"))).toMatch(
			/too long to respond/i,
		);
	});

	it("gives a friendly line for upstream failures, hiding internals", () => {
		const msg = humanizeError(de("SOURCE_UNAVAILABLE", "yahoo-chart-v8: network error"));
		expect(msg).toMatch(/temporarily unavailable/i);
		expect(msg).not.toContain("yahoo-chart-v8");
	});

	it("keeps actionable NOT_FOUND guidance, stripping the source prefix", () => {
		const msg = humanizeError(
			de("NOT_FOUND", 'yahoo-chart-v8: invalid range "7mo". Use one of: 1d, 5d'),
		);
		expect(msg).toBe('Invalid range "7mo". Use one of: 1d, 5d');
	});

	it("rewrites a raw 404 into plain English", () => {
		expect(humanizeError(de("NOT_FOUND", "yahoo-chart-v8: not found (404)"))).toMatch(
			/no data found for that symbol/i,
		);
	});

	it("handles non-DataError throwables", () => {
		expect(humanizeError(new Error("boom"))).toMatch(/something went wrong/i);
		expect(humanizeError("weird")).toMatch(/something went wrong/i);
	});

	it("never leaks a stack or object noise", () => {
		const msg = humanizeError(de("NOT_FOUND", 'invalid NSE symbol: "a b"'));
		expect(msg).not.toContain("{");
		expect(msg).not.toContain("\n");
	});
});

describe("capText — ~4KB response budget", () => {
	it("leaves small text untouched", () => {
		expect(capText("hello\nworld")).toBe("hello\nworld");
	});

	it("trims oversized text to within the budget and notes it", () => {
		const big = Array.from(
			{ length: 500 },
			(_, i) => `line ${i} with some padding text here`,
		).join("\n");
		const out = capText(big);
		expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(4096);
		expect(out).toContain("output trimmed to fit");
	});

	it("keeps whole lines rather than cutting mid-line", () => {
		const big = Array.from({ length: 500 }, (_, i) => `row-${i}`).join("\n");
		const out = capText(big);
		const body = out.replace(/\n… .*$/, "");
		// Every retained line is intact.
		expect(body.split("\n").every((l) => /^row-\d+$/.test(l))).toBe(true);
	});

	it("counts bytes, not characters (multibyte aware)", () => {
		const big = "₹".repeat(3000); // 3 bytes each = 9000 bytes
		const out = capText(big);
		expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(4096);
	});
});

describe("DISCLAIMER", () => {
	it("states informational-only and not investment advice", () => {
		expect(DISCLAIMER.toLowerCase()).toContain("informational");
		expect(DISCLAIMER.toLowerCase()).toContain("not investment advice");
	});
});
