/**
 * Shared HTTP layer for upstream data sources.
 *
 * Behaviour is driven by what the Burse 2 spike actually observed (see
 * DATA_SOURCES.md): upstreams are undocumented, occasionally return an empty
 * body, and answer with HTML when they refuse. So every call is bounded by a
 * timeout, retried once on transient failure, and surfaces a typed error
 * rather than throwing something shapeless.
 *
 * No cookie warm-up anywhere: the spike proved it changes no outcome.
 */

export type DataErrorCode = "SOURCE_UNAVAILABLE" | "NOT_FOUND" | "TIMEOUT";

export class DataError extends Error {
	readonly code: DataErrorCode;
	/** Upstream label, e.g. "yahoo-chart-v8" — for logging, not for callers to branch on. */
	readonly source: string;
	readonly status?: number;
	/** Whether fetchJson should spend its one retry on this failure. */
	readonly retryable: boolean;

	constructor(
		code: DataErrorCode,
		message: string,
		opts: { source: string; status?: number; retryable?: boolean; cause?: unknown },
	) {
		super(message, { cause: opts.cause });
		this.name = "DataError";
		this.code = code;
		this.source = opts.source;
		this.status = opts.status;
		this.retryable = opts.retryable ?? false;
	}
}

export function isDataError(err: unknown): err is DataError {
	return err instanceof DataError;
}

/** Plain browser-like UA. Nothing beyond this — no cookies, no session emulation. */
export const BROWSER_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const DEFAULT_TIMEOUT_MS = 5000;
const RETRY_DELAY_MS = 300;

export type FetchJsonOptions = {
	/** Upstream label used in error messages. */
	source: string;
	headers?: Record<string, string>;
	timeoutMs?: number;
	/** Extra attempts after the first. Default 1 (so: two attempts total). */
	retries?: number;
};

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 404 is a real answer ("no such symbol"), not a fault — never retried.
 * 401/403 were deterministic in the spike, so retrying only wastes the budget.
 * 408/429/5xx and network faults are worth one more go.
 */
function classifyStatus(status: number, source: string, body: string): DataError {
	if (status === 404) {
		return new DataError("NOT_FOUND", `${source}: not found (404)`, { source, status });
	}
	if (status === 401 || status === 403) {
		return new DataError("SOURCE_UNAVAILABLE", `${source}: access denied (${status})`, {
			source,
			status,
		});
	}
	const retryable = status === 408 || status === 429 || status >= 500;
	return new DataError(
		"SOURCE_UNAVAILABLE",
		`${source}: unexpected status ${status}${body ? ` — ${body.slice(0, 120)}` : ""}`,
		{ source, status, retryable },
	);
}

/** One request attempt: returns the raw body text or throws a typed DataError. */
async function requestBody(
	url: string,
	source: string,
	headers: Record<string, string>,
	accept: string,
	timeoutMs: number,
): Promise<string> {
	let res: Response;
	try {
		res = await fetch(url, {
			headers: { "User-Agent": BROWSER_UA, Accept: accept, ...headers },
			signal: AbortSignal.timeout(timeoutMs),
			redirect: "follow",
		});
	} catch (err) {
		const name = (err as { name?: string })?.name;
		if (name === "TimeoutError" || name === "AbortError") {
			throw new DataError("TIMEOUT", `${source}: timed out after ${timeoutMs}ms`, {
				source,
				retryable: true,
				cause: err,
			});
		}
		throw new DataError("SOURCE_UNAVAILABLE", `${source}: network error`, {
			source,
			retryable: true,
			cause: err,
		});
	}

	const body = await res.text();

	if (!res.ok) throw classifyStatus(res.status, source, body);

	// The spike saw one empty 200. Treat it as transient rather than as valid data.
	if (body.trim() === "") {
		throw new DataError("SOURCE_UNAVAILABLE", `${source}: empty response body`, {
			source,
			status: res.status,
			retryable: true,
		});
	}

	return body;
}

/** Retry wrapper shared by fetchJson/fetchText: retries only retryable DataErrors. */
async function runWithRetries<T>(
	source: string,
	retries: number,
	fn: () => Promise<T>,
): Promise<T> {
	let last: DataError | undefined;
	for (let i = 0; i <= retries; i++) {
		if (i > 0) await delay(RETRY_DELAY_MS);
		try {
			return await fn();
		} catch (err) {
			const de = isDataError(err)
				? err
				: new DataError("SOURCE_UNAVAILABLE", `${source}: ${String(err)}`, {
						source,
						cause: err,
					});
			if (!de.retryable) throw de;
			last = de;
		}
	}
	throw last ?? new DataError("SOURCE_UNAVAILABLE", `${source}: exhausted retries`, { source });
}

/**
 * GET a JSON document. Throws {@link DataError} on every failure path.
 *
 * Note the worst case is `timeoutMs * (retries + 1)` plus retry delays — with
 * the defaults, about 10.3s. Callers on a tighter budget should lower timeoutMs.
 */
export async function fetchJson<T>(url: string, opts: FetchJsonOptions): Promise<T> {
	const { source, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, retries = 1 } = opts;
	return runWithRetries(source, retries, async () => {
		const body = await requestBody(url, source, headers, "application/json", timeoutMs);
		try {
			return JSON.parse(body) as T;
		} catch (err) {
			// Refusals arrive as HTML; a 200 that will not parse is worth one retry.
			throw new DataError("SOURCE_UNAVAILABLE", `${source}: response was not valid JSON`, {
				source,
				retryable: true,
				cause: err,
			});
		}
	});
}

/** GET a plain-text document (e.g. a CSV). Throws {@link DataError} on failure. */
export async function fetchText(
	url: string,
	opts: FetchJsonOptions & { accept?: string },
): Promise<string> {
	const {
		source,
		headers = {},
		timeoutMs = DEFAULT_TIMEOUT_MS,
		retries = 1,
		accept = "text/csv,text/plain,*/*",
	} = opts;
	return runWithRetries(source, retries, () =>
		requestBody(url, source, headers, accept, timeoutMs),
	);
}
