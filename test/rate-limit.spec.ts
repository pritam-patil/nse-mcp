import { describe, expect, it } from "vitest";
import type { CacheStore } from "../src/data/cache";
import {
	checkRateLimit,
	RATE_LIMIT_PER_HOUR,
	rateLimitKey,
	rateLimitMessage,
} from "../src/rate-limit";

const NOW = new Date("2026-08-08T10:30:00Z"); // mid-bucket: 30 min left in the hour

function memoryStore(seed: Record<string, string> = {}) {
	const data = new Map(Object.entries(seed));
	const puts: Array<{ key: string; value: string; expirationTtl?: number }> = [];
	const store: CacheStore = {
		get: async (k) => data.get(k) ?? null,
		put: async (k, v, opts) => {
			data.set(k, v);
			puts.push({ key: k, value: v, expirationTtl: opts?.expirationTtl });
		},
	};
	return { store, data, puts };
}

describe("rateLimitKey", () => {
	it("buckets by IP and clock hour", () => {
		const key = rateLimitKey("1.2.3.4", NOW);
		expect(key).toMatch(/^v1:rl:1\.2\.3\.4:\d+$/);
		// Same hour → same key; next hour → different key.
		expect(rateLimitKey("1.2.3.4", new Date(NOW.getTime() + 60_000))).toBe(key);
		expect(rateLimitKey("1.2.3.4", new Date(NOW.getTime() + 3_600_000))).not.toBe(key);
	});

	it("separates IPs", () => {
		expect(rateLimitKey("1.2.3.4", NOW)).not.toBe(rateLimitKey("5.6.7.8", NOW));
	});
});

describe("checkRateLimit", () => {
	it("allows and counts the first call", async () => {
		const { store, data } = memoryStore();
		const result = await checkRateLimit(store, "1.2.3.4", NOW);
		expect(result.allowed).toBe(true);
		expect(data.get(rateLimitKey("1.2.3.4", NOW))).toBe("1");
	});

	it("increments on subsequent calls", async () => {
		const { store, data } = memoryStore();
		await checkRateLimit(store, "1.2.3.4", NOW);
		await checkRateLimit(store, "1.2.3.4", NOW);
		await checkRateLimit(store, "1.2.3.4", NOW);
		expect(data.get(rateLimitKey("1.2.3.4", NOW))).toBe("3");
	});

	it("blocks at the limit with minutes until the bucket resets", async () => {
		const key = rateLimitKey("1.2.3.4", NOW);
		const { store, puts } = memoryStore({ [key]: String(RATE_LIMIT_PER_HOUR) });

		const result = await checkRateLimit(store, "1.2.3.4", NOW);

		expect(result.allowed).toBe(false);
		expect(result.retryMinutes).toBe(30); // 10:30 → bucket resets at 11:00
		expect(puts).toHaveLength(0); // a blocked call is not counted further
	});

	it("allows again in the next hour bucket", async () => {
		const key = rateLimitKey("1.2.3.4", NOW);
		const { store } = memoryStore({ [key]: String(RATE_LIMIT_PER_HOUR) });
		const nextHour = new Date(NOW.getTime() + 3_600_000);
		expect((await checkRateLimit(store, "1.2.3.4", nextHour)).allowed).toBe(true);
	});

	it("does not limit different IPs together", async () => {
		const key = rateLimitKey("1.2.3.4", NOW);
		const { store } = memoryStore({ [key]: String(RATE_LIMIT_PER_HOUR) });
		expect((await checkRateLimit(store, "5.6.7.8", NOW)).allowed).toBe(true);
	});

	it("fails open with no IP (local dev)", async () => {
		const { store, puts } = memoryStore();
		expect((await checkRateLimit(store, null, NOW)).allowed).toBe(true);
		expect(puts).toHaveLength(0);
	});

	it("fails open when KV reads throw", async () => {
		const store: CacheStore = {
			get: async () => {
				throw new Error("kv down");
			},
			put: async () => {
				throw new Error("kv down");
			},
		};
		expect((await checkRateLimit(store, "1.2.3.4", NOW)).allowed).toBe(true);
	});

	it("sets a TTL comfortably beyond the bucket so counters clean themselves up", async () => {
		const { store, puts } = memoryStore();
		await checkRateLimit(store, "1.2.3.4", NOW);
		expect(puts[0].expirationTtl).toBe(2 * 3600);
	});
});

describe("rateLimitMessage", () => {
	it("is friendly, states the limit, and says when to retry", () => {
		const msg = rateLimitMessage(30);
		expect(msg).toContain("60 requests per hour");
		expect(msg).toContain("30 minutes");
		expect(msg).not.toContain("{");
	});

	it("uses the singular for one minute", () => {
		expect(rateLimitMessage(1)).toContain("1 minute.");
	});
});
