/**
 * NSE index levels via the same Yahoo chart v8 endpoint as quotes.ts.
 *
 * Index tickers carry a "^" prefix and take no ".NS" suffix, so they bypass
 * the equity symbol normaliser entirely.
 */

import { isDataError, type DataErrorCode } from "./http";
import { fetchChart, mapQuote, type Quote } from "./quotes";

export const NSE_INDICES = {
	NIFTY_50: { label: "NIFTY 50", yahooSymbol: "^NSEI" },
	NIFTY_BANK: { label: "NIFTY BANK", yahooSymbol: "^NSEBANK" },
} as const;

export type IndexKey = keyof typeof NSE_INDICES;

export const INDEX_KEYS = Object.keys(NSE_INDICES) as IndexKey[];

export type IndexQuote = Quote & {
	key: IndexKey;
	label: string;
};

export type IndexFailure = {
	key: IndexKey;
	code: DataErrorCode;
	message: string;
};

export async function getIndex(key: IndexKey): Promise<IndexQuote> {
	const { label, yahooSymbol } = NSE_INDICES[key];
	const raw = await fetchChart(yahooSymbol);
	// Index quotes have no bare NSE symbol, so the Yahoo ticker is the display symbol.
	return { ...mapQuote(raw, yahooSymbol, yahooSymbol), key, label };
}

/**
 * Fetch every index, tolerating partial failure.
 *
 * One index being unavailable should not blank out the other, so failures are
 * returned alongside successes rather than thrown. Callers that need
 * all-or-nothing can check `errors.length`.
 */
export async function getIndices(): Promise<{ indices: IndexQuote[]; errors: IndexFailure[] }> {
	const settled = await Promise.all(
		INDEX_KEYS.map(async (key): Promise<IndexQuote | IndexFailure> => {
			try {
				return await getIndex(key);
			} catch (err) {
				return {
					key,
					code: isDataError(err) ? err.code : "SOURCE_UNAVAILABLE",
					message: err instanceof Error ? err.message : String(err),
				};
			}
		}),
	);

	const indices = settled.filter((r): r is IndexQuote => "source" in r);
	const errors = settled.filter((r): r is IndexFailure => !("source" in r));
	return { indices, errors };
}
