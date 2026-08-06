/**
 * TEMPORARY debug route (Burse 2).
 *
 * Probes candidate upstream data sources from the deployed Worker and reports
 * what each one does when called from Cloudflare's network. Existence-check
 * only: browser-like headers and a cookie warm-up, nothing further.
 *
 * Delete this file and its route in `src/index.ts` once DATA_SOURCES.md is settled.
 */

const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const NAV_HEADERS: Record<string, string> = {
	"User-Agent": UA,
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.9",
	"Upgrade-Insecure-Requests": "1",
	"Sec-Fetch-Dest": "document",
	"Sec-Fetch-Mode": "navigate",
	"Sec-Fetch-Site": "none",
	"Sec-Fetch-User": "?1",
};

function xhrHeaders(referer: string): Record<string, string> {
	return {
		"User-Agent": UA,
		Accept: "application/json, text/plain, */*",
		"Accept-Language": "en-US,en;q=0.9",
		Referer: referer,
		"X-Requested-With": "XMLHttpRequest",
		"Sec-Fetch-Dest": "empty",
		"Sec-Fetch-Mode": "cors",
		"Sec-Fetch-Site": "same-origin",
	};
}

/** Headers that reveal which layer answered (origin vs. edge vs. bot filter). */
function diagHeaders(h: Headers): Record<string, string> {
	const keys = ["server", "cf-ray", "cf-cache-status", "cf-mitigated", "content-type", "retry-after", "x-cache"];
	const out: Record<string, string> = {};
	for (const k of keys) {
		const v = h.get(k);
		if (v) out[k] = v;
	}
	return out;
}

function preview(body: string, n = 200): string {
	return body.slice(0, n).replace(/\s+/g, " ").trim();
}

type Warmup = {
	status?: number;
	cookieNames?: string[];
	cookieCount?: number;
	ms?: number;
	error?: string;
};

/** Hit the homepage like a browser would, to pick up whatever cookies it sets. */
async function warmUp(): Promise<{ warmup: Warmup; cookieHeader: string }> {
	const t0 = Date.now();
	try {
		const res = await fetch("https://www.nseindia.com/", {
			headers: NAV_HEADERS,
			redirect: "follow",
		});
		// Drain the body so the connection is released.
		await res.text();

		const setCookies =
			typeof res.headers.getSetCookie === "function"
				? res.headers.getSetCookie()
				: ((res.headers.get("set-cookie") ?? "").split(/,(?=[^;]+=)/).filter(Boolean) as string[]);

		const pairs = setCookies.map((c) => c.split(";")[0].trim()).filter(Boolean);

		return {
			warmup: {
				status: res.status,
				cookieCount: pairs.length,
				cookieNames: pairs.map((p) => p.split("=")[0]),
				ms: Date.now() - t0,
			},
			cookieHeader: pairs.join("; "),
		};
	} catch (err) {
		return {
			warmup: { error: String(err), ms: Date.now() - t0 },
			cookieHeader: "",
		};
	}
}

type Probe = {
	id: string;
	label: string;
	url: string;
	status?: number;
	ok?: boolean;
	bodyLength?: number;
	preview?: string;
	headers?: Record<string, string>;
	warmup?: Warmup;
	error?: string;
	ms: number;
};

async function probe(
	id: string,
	label: string,
	url: string,
	headers: Record<string, string>,
	warmup?: Warmup,
): Promise<Probe> {
	const t0 = Date.now();
	try {
		const res = await fetch(url, { headers, redirect: "follow" });
		const body = await res.text();
		return {
			id,
			label,
			url,
			status: res.status,
			ok: res.ok,
			bodyLength: body.length,
			preview: preview(body),
			headers: diagHeaders(res.headers),
			warmup,
			ms: Date.now() - t0,
		};
	} catch (err) {
		return { id, label, url, error: String(err), warmup, ms: Date.now() - t0 };
	}
}

export async function handleSpike(request: Request): Promise<Response> {
	const started = Date.now();
	const colo = (request as { cf?: { colo?: string } }).cf?.colo ?? null;

	// (a) + (b) share one warm-up, the way a real browser session would.
	const { warmup, cookieHeader } = await warmUp();
	const nseHeaders = (referer: string) => {
		const h = xhrHeaders(referer);
		if (cookieHeader) h.Cookie = cookieHeader;
		return h;
	};

	const results = await Promise.all([
		probe(
			"a",
			"NSE quote-equity (RELIANCE)",
			"https://www.nseindia.com/api/quote-equity?symbol=RELIANCE",
			nseHeaders("https://www.nseindia.com/get-quotes/equity?symbol=RELIANCE"),
			warmup,
		),
		probe(
			"b",
			"NSE corporate-announcements (equities)",
			"https://www.nseindia.com/api/corporate-announcements?index=equities",
			nseHeaders("https://www.nseindia.com/companies-listing/corporate-filings-announcements"),
			warmup,
		),
		// Sibling NSE endpoint, same /api/ family as (a) — is the 403 path-specific?
		probe(
			"d",
			"NSE marketStatus",
			"https://www.nseindia.com/api/marketStatus",
			nseHeaders("https://www.nseindia.com/"),
			warmup,
		),
		// Controls: same requests with no cookie jar, to isolate what the warm-up buys.
		probe(
			"a0",
			"NSE quote-equity (RELIANCE) — no cookies",
			"https://www.nseindia.com/api/quote-equity?symbol=RELIANCE",
			xhrHeaders("https://www.nseindia.com/get-quotes/equity?symbol=RELIANCE"),
		),
		probe(
			"b0",
			"NSE corporate-announcements — no cookies",
			"https://www.nseindia.com/api/corporate-announcements?index=equities",
			xhrHeaders("https://www.nseindia.com/companies-listing/corporate-filings-announcements"),
		),
		probe(
			"c",
			"Yahoo Finance chart (RELIANCE.NS)",
			"https://query1.finance.yahoo.com/v8/finance/chart/RELIANCE.NS",
			{ "User-Agent": UA, Accept: "application/json,text/plain,*/*" },
		),
	]);

	return Response.json(
		{ colo, totalMs: Date.now() - started, results },
		{ headers: { "Cache-Control": "no-store" } },
	);
}
