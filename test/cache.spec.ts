import { describe, expect, it, vi } from "vitest";
import {
	cacheKey,
	quoteTtlSeconds,
	statusTtlSeconds,
	STALE_RETENTION_SECONDS,
	TTL_DEFAULT_SECONDS,
	TTL_MARKET_HOURS_SECONDS,
	withCache,
	type CacheStore,
} from "../src/data/cache";
import { DataError } from "../src/data/http";

function ist(iso: string): Date {
	return new Date(`${iso}+05:30`);
}

/** In-memory CacheStore that records puts. */
function memoryStore(seed: Record<string, string> = {}) {
	const data = new Map(Object.entries(seed));
	const puts: Array<{ key: string; value: string; expirationTtl?: number }> = [];
	const store: CacheStore = {
		get: async (key) => data.get(key) ?? null,
		put: async (key, value, opts) => {
			data.set(key, value);
			puts.push({ key, value, expirationTtl: opts?.expirationTtl });
		},
	};
	return { store, data, puts };
}

function envelope(data: unknown, storedAt: string): string {
	return JSON.stringify({ v: 1, storedAt, data });
}

const NOW = new Date("2026-08-03T10:00:00Z");
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000).toISOString();

describe("cacheKey", () => {
	it("uses the v1:<kind>:<id> format", () => {
		expect(cacheKey.quote("RELIANCE")).toBe("v1:quote:RELIANCE");
		expect(cacheKey.index("NIFTY_50")).toBe("v1:index:NIFTY_50");
		expect(cacheKey.indices()).toBe("v1:indices");
		expect(cacheKey.announcements()).toBe("v1:announcements:equities");
		expect(cacheKey.status()).toBe("v1:status");
	});
});

describe("TTL selection", () => {
	it("uses 60s for quotes during NSE hours", () => {
		expect(quoteTtlSeconds(ist("2026-08-03T12:00:00"))).toBe(TTL_MARKET_HOURS_SECONDS);
	});

	it("uses 15 min for quotes outside NSE hours", () => {
		expect(quoteTtlSeconds(ist("2026-08-03T20:00:00"))).toBe(TTL_DEFAULT_SECONDS);
		expect(quoteTtlSeconds(ist("2026-08-08T12:00:00"))).toBe(TTL_DEFAULT_SECONDS);
	});

	it("clamps the status TTL so it cannot outlive the next open", () => {
		// 09:10 IST: 5 minutes to the open, so a 15-minute TTL would span it.
		expect(statusTtlSeconds(ist("2026-08-03T09:10:00"))).toBe(5 * 60);
	});

	it("clamps the status TTL so it cannot outlive the next close", () => {
		// 15:29 IST: 1 minute to the close, shorter than the 60s in-hours TTL.
		expect(statusTtlSeconds(ist("2026-08-03T15:29:30"))).toBe(30);
	});

	it("never returns a zero or negative TTL at a boundary", () => {
		expect(statusTtlSeconds(ist("2026-08-03T09:14:59"))).toBeGreaterThan(0);
		expect(statusTtlSeconds(ist("2026-08-03T15:29:59"))).toBeGreaterThan(0);
	});
});

describe("withCache — hits and misses", () => {
	it("fetches and stores on a cold cache", async () => {
		const { store, puts } = memoryStore();
		const fetcher = vi.fn(async () => ({ price: 100 }));

		const result = await withCache(store, "v1:quote:X", 60, fetcher, { now: NOW });

		expect(result).toEqual({
			price: 100,
			stale: false,
			cachedAt: NOW.toISOString(),
			cacheHit: false,
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(puts).toHaveLength(1);
	});

	it("retains entries far longer than the TTL so they can be served stale", async () => {
		const { store, puts } = memoryStore();
		await withCache(store, "k", 60, async () => ({ a: 1 }), { now: NOW });
		expect(puts[0].expirationTtl).toBe(STALE_RETENTION_SECONDS);
		expect(STALE_RETENTION_SECONDS).toBeGreaterThan(TTL_DEFAULT_SECONDS);
	});

	it("serves a fresh entry without calling upstream", async () => {
		const { store } = memoryStore({ k: envelope({ price: 42 }, ago(30)) });
		const fetcher = vi.fn(async () => ({ price: 99 }));

		const result = await withCache(store, "k", 60, fetcher, { now: NOW });

		expect(result).toEqual({ price: 42, stale: false, cachedAt: ago(30), cacheHit: true });
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("refetches once the entry is older than the TTL", async () => {
		const { store } = memoryStore({ k: envelope({ price: 42 }, ago(120)) });
		const fetcher = vi.fn(async () => ({ price: 99 }));

		const result = await withCache(store, "k", 60, fetcher, { now: NOW });

		expect(result.price).toBe(99);
		expect(result.stale).toBe(false);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("bypasses caching entirely when the store is null", async () => {
		const fetcher = vi.fn(async () => ({ price: 1 }));
		const result = await withCache(null, "k", 60, fetcher, { now: NOW });
		expect(result).toEqual({
			price: 1,
			stale: false,
			cachedAt: NOW.toISOString(),
			cacheHit: false,
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
});

describe("withCache — stale on upstream failure", () => {
	it("serves the last cached value with stale: true", async () => {
		const { store } = memoryStore({ k: envelope({ price: 42 }, ago(3600)) });
		const fetcher = vi.fn(async () => {
			throw new DataError("SOURCE_UNAVAILABLE", "upstream down", { source: "test" });
		});

		const result = await withCache(store, "k", 60, fetcher, { now: NOW });

		expect(result).toEqual({ price: 42, stale: true, cachedAt: ago(3600), cacheHit: true });
	});

	it("serves stale however old the entry is", async () => {
		const { store } = memoryStore({ k: envelope({ price: 42 }, ago(6 * 24 * 3600)) });
		const result = await withCache(
			store,
			"k",
			60,
			async (): Promise<{ price: number }> => {
				throw new Error("down");
			},
			{ now: NOW },
		);
		expect(result.stale).toBe(true);
	});

	it("propagates the error when there is nothing cached", async () => {
		const { store } = memoryStore();
		await expect(
			withCache(
				store,
				"k",
				60,
				async () => {
					throw new DataError("TIMEOUT", "timed out", { source: "test" });
				},
				{ now: NOW },
			),
		).rejects.toBeInstanceOf(DataError);
	});

	it("does not overwrite the cached value when serving stale", async () => {
		const { store, puts } = memoryStore({ k: envelope({ price: 42 }, ago(3600)) });
		await withCache(
			store,
			"k",
			60,
			async () => {
				throw new Error("down");
			},
			{ now: NOW },
		);
		expect(puts).toHaveLength(0);
	});
});

describe("withCache — degraded results", () => {
	const partial = { indices: [1], errors: ["boom"] };
	const shouldCache = (v: { errors: unknown[] }) => v.errors.length === 0;

	it("does not store a result that fails shouldCache", async () => {
		const { store, puts } = memoryStore();
		const result = await withCache(store, "k", 60, async () => partial, {
			now: NOW,
			shouldCache,
		});
		expect(puts).toHaveLength(0);
		expect(result.stale).toBe(false);
		expect(result.cachedAt).toBeNull();
	});

	it("prefers an older complete entry over a fresh degraded one", async () => {
		const complete = { indices: [1, 2], errors: [] };
		const { store } = memoryStore({ k: envelope(complete, ago(3600)) });

		const result = await withCache(store, "k", 60, async () => partial, {
			now: NOW,
			shouldCache,
		});

		expect(result.indices).toEqual([1, 2]);
		expect(result.stale).toBe(true);
	});
});

describe("withCache — resilience", () => {
	it("treats a corrupt entry as a miss", async () => {
		const { store } = memoryStore({ k: "not json at all" });
		const result = await withCache(store, "k", 60, async () => ({ ok: 1 }), { now: NOW });
		expect(result).toMatchObject({ ok: 1, stale: false });
	});

	it("treats an entry with an unknown version as a miss", async () => {
		const { store } = memoryStore({ k: JSON.stringify({ v: 99, storedAt: ago(1), data: {} }) });
		const result = await withCache(store, "k", 60, async () => ({ ok: 1 }), { now: NOW });
		expect(result).toMatchObject({ ok: 1, stale: false });
	});

	it("still serves data when the KV read throws", async () => {
		const store: CacheStore = {
			get: async () => {
				throw new Error("kv unavailable");
			},
			put: async () => {},
		};
		const result = await withCache(store, "k", 60, async () => ({ ok: 1 }), { now: NOW });
		expect(result).toMatchObject({ ok: 1 });
	});

	it("still serves data when the KV write throws", async () => {
		const store: CacheStore = {
			get: async () => null,
			put: async () => {
				throw new Error("kv write failed");
			},
		};
		const result = await withCache(store, "k", 60, async () => ({ ok: 1 }), { now: NOW });
		expect(result).toMatchObject({ ok: 1, stale: false });
	});

	it("refetches rather than trusting an entry stamped in the future", async () => {
		const future = new Date(NOW.getTime() + 60_000).toISOString();
		const { store } = memoryStore({ k: envelope({ price: 1 }, future) });
		const fetcher = vi.fn(async () => ({ price: 2 }));
		const result = await withCache(store, "k", 60, fetcher, { now: NOW });
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(result.price).toBe(2);
	});
});
