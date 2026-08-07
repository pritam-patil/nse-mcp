import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheKey, type CacheStore } from "../src/data/cache";
import {
	classifyAction,
	getCorporateActions,
	mapCorporateActions,
	type CorporateActionsResult,
} from "../src/data/corporate-actions";
import { formatCorporateActions } from "../src/format";
import { fixture } from "./fixtures";

const raw = fixture<unknown[]>("nse-corporate-actions-reliance.json");
const actions = mapCorporateActions(raw);

function memoryStore(seed?: string, key = cacheKey.corporateActions("RELIANCE")) {
	const data = new Map<string, string>();
	if (seed !== undefined) data.set(key, seed);
	const store: CacheStore = {
		get: async (k) => data.get(k) ?? null,
		put: async (k, v) => void data.set(k, v),
	};
	return { store, data };
}

describe("classifyAction", () => {
	it.each([
		["Dividend - Rs 6 Per Share", "Dividend"],
		["Bonus 1:1", "Bonus"],
		["Face Value Split (Sub-Division) - From Rs 10 to Rs 5", "Split"],
		["Rights 1:15 @ Premium Rs 1247", "Rights"],
		["Demerger", "Demerger"],
		["Annual General Meeting", "AGM"],
		["Scheme of Arrangement", "Other"],
	])("classifies %j as %s", (subject, type) => {
		expect(classifyAction(subject)).toBe(type);
	});

	it("prefers the concrete action when a subject names two", () => {
		// "Annual General Meeting/Dividend - Rs 6.50" is a dividend, not just an AGM.
		expect(classifyAction("Annual General Meeting/Dividend - Rs 6.50 Per Share")).toBe(
			"Dividend",
		);
	});

	it("treats missing subject as Other", () => {
		expect(classifyAction(null)).toBe("Other");
	});
});

describe("mapCorporateActions — real RELIANCE response", () => {
	it("maps and classifies records", () => {
		expect(actions.length).toBe(20);
		expect(actions[0]).toMatchObject({
			company: "Reliance Industries Limited",
			type: "Dividend",
			subject: "Dividend - Rs 6 Per Share",
			exDate: "05-Jun-2026",
			exDateIso: "2026-06-05",
			source: "nse-corporate-actions",
		});
	});

	it("sorts by ex-date, newest first", () => {
		const iso = actions.map((a) => a.exDateIso).filter(Boolean) as string[];
		expect(iso).toEqual([...iso].sort().reverse());
		expect(actions[0].exDateIso).toBe("2026-06-05");
	});

	it("finds the dividend, bonus and rights entries", () => {
		const types = new Set(actions.map((a) => a.type));
		expect(types).toContain("Dividend");
		expect(types).toContain("Bonus");
		expect(types).toContain("Rights");
	});

	it("nulls NSE's '-' placeholder dates", () => {
		expect(actions.every((a) => a.recordDate !== "-")).toBe(true);
	});
});

describe("mapCorporateActions — degraded", () => {
	it.each([null, undefined, {}, "nope", 42])("returns [] for non-array %j", (v) => {
		expect(mapCorporateActions(v)).toEqual([]);
	});

	it("skips non-object entries", () => {
		expect(
			mapCorporateActions([null, 1, { subject: "Bonus 1:1", exDate: "01-Jan-2026" }]),
		).toHaveLength(1);
	});
});

describe("getCorporateActions", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("fetches, caches under v1:corpactions:<symbol>, and normalises the symbol", async () => {
		const fn = vi.fn(async () => new Response(JSON.stringify(raw)));
		vi.stubGlobal("fetch", fn);
		const { data } = memoryStore();
		const store: CacheStore = {
			get: async (k) => data.get(k) ?? null,
			put: async (k, v) => void data.set(k, v),
		};

		const result = await getCorporateActions(store, "reliance.ns");
		expect(result.actions[0].type).toBe("Dividend");
		expect([...data.keys()]).toEqual(["v1:corpactions:RELIANCE"]);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("serves stale on upstream failure", async () => {
		const seed = JSON.stringify({
			v: 1,
			storedAt: "2026-08-01T00:00:00.000Z",
			data: { actions: actions.slice(0, 3) },
		});
		const { store } = memoryStore(seed);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("down");
			}),
		);
		const result = await getCorporateActions(
			store,
			"RELIANCE",
			new Date("2026-08-07T00:00:00.000Z"),
		);
		expect(result.stale).toBe(true);
		expect(result.actions).toHaveLength(3);
	});

	it("returns an empty result for an invalid symbol without fetching", async () => {
		const fn = vi.fn();
		vi.stubGlobal("fetch", fn);
		const result = await getCorporateActions(memoryStore().store, "not a symbol");
		expect(result.actions).toEqual([]);
		expect(fn).not.toHaveBeenCalled();
	});
});

describe("formatCorporateActions", () => {
	const cached = (
		data: CorporateActionsResult,
		stale = false,
	): typeof data & {
		stale: boolean;
		cachedAt: string | null;
	} => ({ ...data, stale, cachedAt: "2026-08-07T00:00:00.000Z" });

	it("renders type, subject, ex-date and record date", () => {
		const text = formatCorporateActions(cached({ actions: actions.slice(0, 2) }), "RELIANCE");
		expect(text.split("\n")[0]).toBe(
			"Dividend: Dividend - Rs 6 Per Share (ex-date 05-Jun-2026, record 05-Jun-2026)",
		);
	});

	it("gives a friendly message when there are none", () => {
		expect(formatCorporateActions(cached({ actions: [] }), "reliance")).toBe(
			"No recent corporate actions for RELIANCE.",
		);
	});

	it("marks stale data", () => {
		const text = formatCorporateActions(
			cached({ actions: actions.slice(0, 1) }, true),
			"RELIANCE",
		);
		expect(text).toContain("Note: stale");
	});

	it("is not JSON", () => {
		const text = formatCorporateActions(cached({ actions: actions.slice(0, 3) }), "RELIANCE");
		expect(text).not.toContain("{");
	});
});
