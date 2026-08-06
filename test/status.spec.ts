import { describe, expect, it } from "vitest";
import { mapMarketStatus, normalizeStatus } from "../src/data/status";
import { fixture } from "./fixtures";

const raw = fixture("nse-market-status.json");

describe("normalizeStatus", () => {
	it.each([
		["Open", "open"],
		["Closed", "closed"],
		["Market is Open", "open"],
		["Normal Market has Closed", "closed"],
	])("maps %j to %j", (input, expected) => {
		expect(normalizeStatus(input)).toBe(expected);
	});

	it.each([null, undefined, "", "   ", 42, {}])("returns unknown for %j", (v) => {
		expect(normalizeStatus(v)).toBe("unknown");
	});
});

describe("mapMarketStatus — real /api/marketStatus response", () => {
	const status = mapMarketStatus(raw);

	it("takes the headline status from Capital Market", () => {
		expect(status.status).toBe("closed");
		expect(status.market).toBe("NSE");
		expect(status.headlineSegment).toBe("Capital Market");
	});

	it("does NOT report open just because another segment is open", () => {
		// The real payload has Commodity "Open" while Capital Market is "Closed".
		const commodity = status.segments.find((s) => s.market === "Commodity");
		expect(commodity?.status).toBe("open");
		expect(status.status).toBe("closed");
	});

	it("drops the NIFTY50-USD row, which is a quote rather than a segment", () => {
		expect(status.segments.every((s) => s.market !== "")).toBe(true);
		expect(status.segments.map((s) => s.market)).toEqual([
			"Capital Market",
			"Currency",
			"Commodity",
			"Debt",
			"currencyfuture",
		]);
	});

	it("maps the Capital Market segment in full", () => {
		expect(status.segments[0]).toMatchObject({
			market: "Capital Market",
			status: "closed",
			statusRaw: "Closed",
			tradeDate: "06-Aug-2026 15:30",
			index: "NIFTY 50",
			last: 24636,
			percentChange: 0.05,
			message: "Normal Market has Closed",
		});
	});

	it('coerces "" numerics to null instead of 0', () => {
		const currency = status.segments.find((s) => s.market === "Currency");
		expect(currency?.last).toBeNull();
		expect(currency?.variation).toBeNull();
		expect(currency?.percentChange).toBeNull();
	});

	it('parses numeric strings like "95.0100"', () => {
		const cf = status.segments.find((s) => s.market === "currencyfuture");
		expect(cf?.last).toBe(95.01);
	});

	it("reports the source", () => {
		expect(status.source).toBe("nse-market-status");
	});
});

describe("mapMarketStatus — degraded payloads", () => {
	it.each([null, undefined, {}, { marketState: null }, { marketState: "nope" }, []])(
		"returns unknown with no segments for %j",
		(input) => {
			const s = mapMarketStatus(input);
			expect(s.status).toBe("unknown");
			expect(s.segments).toEqual([]);
		},
	);

	it("returns unknown when Capital Market is absent", () => {
		const s = mapMarketStatus({ marketState: [{ market: "Currency", marketStatus: "Open" }] });
		expect(s.status).toBe("unknown");
		expect(s.segments).toHaveLength(1);
	});

	it("matches the headline segment case-insensitively", () => {
		const s = mapMarketStatus({
			marketState: [{ market: "capital market", marketStatus: "Open" }],
		});
		expect(s.status).toBe("open");
	});
});
