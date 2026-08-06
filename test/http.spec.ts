import { afterEach, describe, expect, it, vi } from "vitest";
import { DataError, fetchJson, isDataError } from "../src/data/http";

const TEST_URL = "https://example.test/data.json";

/** Params are typed loosely: the Workers `RequestInit` clashes with Node's DOM lib. */
function mockFetch(...responses: Array<Response | Error>) {
	const fn = vi.fn(async (_input: unknown, _init?: unknown) => {
		const next = responses.shift();
		if (next === undefined) throw new Error("fetch called more times than stubbed");
		if (next instanceof Error) throw next;
		return next;
	});
	vi.stubGlobal("fetch", fn);
	return fn;
}

function headersOf(fn: ReturnType<typeof mockFetch>, call = 0): Record<string, string> {
	const init = fn.mock.calls[call]?.[1] as { headers?: Record<string, string> } | undefined;
	return init?.headers ?? {};
}

function named(name: string): Error {
	const e = new Error(name);
	e.name = name;
	return e;
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "NO_THROW";
	} catch (err) {
		return isDataError(err) ? err.code : `UNTYPED:${String(err)}`;
	}
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchJson — success", () => {
	it("returns parsed JSON on 200", async () => {
		mockFetch(json({ ok: true }));
		await expect(fetchJson(TEST_URL, { source: "test" })).resolves.toEqual({ ok: true });
	});

	it("sends a browser-like User-Agent and merges caller headers", async () => {
		const fn = mockFetch(json({}));
		await fetchJson(TEST_URL, { source: "test", headers: { Referer: "https://ref.test/" } });
		const headers = headersOf(fn);
		expect(headers["User-Agent"]).toMatch(/^Mozilla\/5\.0/);
		expect(headers.Referer).toBe("https://ref.test/");
	});

	it("sends no Cookie header — the spike showed the warm-up is pointless", async () => {
		const fn = mockFetch(json({}));
		await fetchJson(TEST_URL, { source: "test" });
		expect(Object.keys(headersOf(fn)).map((k) => k.toLowerCase())).not.toContain("cookie");
	});
});

describe("fetchJson — typed errors", () => {
	it("maps 404 to NOT_FOUND", async () => {
		mockFetch(json({ error: "nope" }, 404));
		await expect(codeOf(fetchJson(TEST_URL, { source: "test" }))).resolves.toBe("NOT_FOUND");
	});

	it("maps 403 to SOURCE_UNAVAILABLE", async () => {
		mockFetch(new Response("<html>Access Denied</html>", { status: 403 }));
		await expect(codeOf(fetchJson(TEST_URL, { source: "test" }))).resolves.toBe(
			"SOURCE_UNAVAILABLE",
		);
	});

	it("maps a timeout to TIMEOUT", async () => {
		mockFetch(named("TimeoutError"), named("TimeoutError"));
		await expect(codeOf(fetchJson(TEST_URL, { source: "test" }))).resolves.toBe("TIMEOUT");
	});

	it("maps a network fault to SOURCE_UNAVAILABLE", async () => {
		mockFetch(named("TypeError"), named("TypeError"));
		await expect(codeOf(fetchJson(TEST_URL, { source: "test" }))).resolves.toBe(
			"SOURCE_UNAVAILABLE",
		);
	});

	it("always throws DataError, never a bare Error", async () => {
		mockFetch(json({}, 404));
		await expect(fetchJson(TEST_URL, { source: "test" })).rejects.toBeInstanceOf(DataError);
	});
});

describe("fetchJson — retry policy", () => {
	it("recovers from the transient empty 200 seen in the spike", async () => {
		const fn = mockFetch(new Response("", { status: 200 }), json({ recovered: true }));
		await expect(fetchJson(TEST_URL, { source: "test" })).resolves.toEqual({ recovered: true });
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("retries a 5xx exactly once, then gives up", async () => {
		const fn = mockFetch(json({}, 503), json({}, 503));
		await expect(codeOf(fetchJson(TEST_URL, { source: "test" }))).resolves.toBe(
			"SOURCE_UNAVAILABLE",
		);
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("retries a 429", async () => {
		const fn = mockFetch(new Response("Too Many Requests", { status: 429 }), json({ ok: 1 }));
		await expect(fetchJson(TEST_URL, { source: "test" })).resolves.toEqual({ ok: 1 });
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("retries unparseable JSON", async () => {
		const fn = mockFetch(new Response("<html>nope</html>", { status: 200 }), json({ ok: 1 }));
		await expect(fetchJson(TEST_URL, { source: "test" })).resolves.toEqual({ ok: 1 });
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("does NOT retry a 404 — it is an answer, not a fault", async () => {
		const fn = mockFetch(json({}, 404));
		await codeOf(fetchJson(TEST_URL, { source: "test" }));
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("does NOT retry a 403 — the spike showed it is deterministic", async () => {
		const fn = mockFetch(new Response("denied", { status: 403 }));
		await codeOf(fetchJson(TEST_URL, { source: "test" }));
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("honours retries: 0", async () => {
		const fn = mockFetch(json({}, 503));
		await codeOf(fetchJson(TEST_URL, { source: "test", retries: 0 }));
		expect(fn).toHaveBeenCalledTimes(1);
	});
});
