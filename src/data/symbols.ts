/**
 * NSE equity symbol master list, and search over it.
 *
 * The list is NSE's EQUITY_L.csv — the full roster of listed equities. It
 * changes rarely (new listings, delistings), so it is refreshed weekly by a
 * cron trigger into KV under `v1:symbols`, and every search reads from KV
 * rather than hitting NSE. See scripts/refresh-symbols.mjs for manual seeding.
 */

import { cacheKey, type CacheStore } from "./cache";
import { DataError, fetchText } from "./http";

export const EQUITY_L_URL = "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv";
const SOURCE = "nse-equity-list";

export type SymbolEntry = {
	symbol: string;
	name: string;
};

type SymbolStore = {
	v: 1;
	storedAt: string;
	count: number;
	/** [symbol, name] tuples — compact, ~100KB for the full list. */
	symbols: [string, string][];
};

/** Parse one CSV line, honouring double-quoted fields (rare, but cheap insurance). */
function splitCsvLine(line: string): string[] {
	const out: string[] = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quoted) {
			if (ch === '"') {
				if (line[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					quoted = false;
				}
			} else {
				field += ch;
			}
		} else if (ch === '"') {
			quoted = true;
		} else if (ch === ",") {
			out.push(field);
			field = "";
		} else {
			field += ch;
		}
	}
	out.push(field);
	return out;
}

/**
 * Parse EQUITY_L.csv into symbol entries.
 *
 * Columns are `SYMBOL, NAME OF COMPANY, SERIES, ...`; only the first two are
 * kept. The header row is skipped, and rows without both a symbol and a name
 * are dropped rather than stored blank.
 */
export function parseEquityCsv(csv: string): SymbolEntry[] {
	const lines = csv.split(/\r?\n/);
	const entries: SymbolEntry[] = [];
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) continue;
		const cols = splitCsvLine(line);
		const symbol = (cols[0] ?? "").trim();
		const name = (cols[1] ?? "").trim();
		if (symbol && name) entries.push({ symbol, name });
	}
	return entries;
}

/**
 * Fetch EQUITY_L.csv, parse it, and store it in KV under `v1:symbols`.
 *
 * Called by the weekly cron handler and by the manual refresh script. Throws
 * if the download fails or yields an implausibly small list, so a bad fetch
 * never overwrites a good stored list with garbage.
 */
export async function refreshSymbols(
	store: CacheStore,
	now: Date = new Date(),
): Promise<{ count: number }> {
	const csv = await fetchText(EQUITY_L_URL, {
		source: SOURCE,
		// A larger budget than the tool default: this is a ~170KB file on a cron.
		timeoutMs: 15_000,
	});
	const entries = parseEquityCsv(csv);

	// The real list has ~2000 rows; a tiny result means a malformed download.
	if (entries.length < 100) {
		throw new DataError("SOURCE_UNAVAILABLE", `${SOURCE}: only ${entries.length} rows parsed`, {
			source: SOURCE,
		});
	}

	const payload: SymbolStore = {
		v: 1,
		storedAt: now.toISOString(),
		count: entries.length,
		symbols: entries.map((e) => [e.symbol, e.name]),
	};
	await store.put(cacheKey.symbols(), JSON.stringify(payload));
	return { count: entries.length };
}

/** Read the stored list plus when it was last refreshed. Empty + null if absent/corrupt. */
export async function loadSymbolStore(
	store: CacheStore,
): Promise<{ symbols: SymbolEntry[]; updatedAt: string | null }> {
	const raw = await store.get(cacheKey.symbols()).catch(() => null);
	if (!raw) return { symbols: [], updatedAt: null };
	try {
		const parsed = JSON.parse(raw) as SymbolStore;
		if (parsed?.v !== 1 || !Array.isArray(parsed.symbols))
			return { symbols: [], updatedAt: null };
		const symbols = parsed.symbols
			.filter((t) => Array.isArray(t) && t.length >= 2)
			.map(([symbol, name]) => ({ symbol, name }));
		return { symbols, updatedAt: typeof parsed.storedAt === "string" ? parsed.storedAt : null };
	} catch {
		return { symbols: [], updatedAt: null };
	}
}

/** Read the stored symbol list from KV. Returns [] if never populated or corrupt. */
export async function loadSymbols(store: CacheStore): Promise<SymbolEntry[]> {
	return (await loadSymbolStore(store)).symbols;
}

// ---- search ----------------------------------------------------------------

/** Levenshtein distance, capped: returns `max + 1` once it is provably exceeded. */
function boundedLevenshtein(a: string, b: string, max: number): number {
	if (Math.abs(a.length - b.length) > max) return max + 1;
	const prev = new Array(b.length + 1);
	const curr = new Array(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		let rowMin = curr[0];
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
			if (curr[j] < rowMin) rowMin = curr[j];
		}
		if (rowMin > max) return max + 1;
		for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
	}
	return prev[b.length];
}

/** 0–1 similarity from edit distance, relative to the longer string. */
function similarity(a: string, b: string): number {
	const longer = Math.max(a.length, b.length);
	if (longer === 0) return 1;
	const max = Math.ceil(longer * 0.5);
	const dist = boundedLevenshtein(a, b, max);
	return dist > max ? 0 : 1 - dist / longer;
}

/** True if every char of `q` appears in `s` in order (typo-tolerant loose match). */
function isSubsequence(q: string, s: string): boolean {
	let i = 0;
	for (let j = 0; j < s.length && i < q.length; j++) {
		if (s[j] === q[i]) i++;
	}
	return i === q.length;
}

/**
 * Score one entry against a lowercased query.
 *
 * Substring matches occupy the high bands (400–1000) and always outrank fuzzy
 * matches (≤200), so an exact-ish hit is never buried under a typo-tolerant one.
 * Returns 0 for no match.
 */
function scoreEntry(q: string, entry: SymbolEntry): number {
	const sym = entry.symbol.toLowerCase();
	const nm = entry.name.toLowerCase();

	if (sym === q) return 1000;
	if (sym.startsWith(q)) return 900 - (sym.length - q.length);
	if (nm === q) return 850;

	const words = nm.split(/[^a-z0-9]+/).filter(Boolean);
	if (words.includes(q)) return 820;
	if (words.some((w) => w.startsWith(q))) return 700;
	if (sym.includes(q)) return 600 - sym.indexOf(q);
	if (nm.includes(q)) return 500 - Math.min(nm.indexOf(q), 99);

	// Fuzzy fallback for typos, kept strictly below the substring bands.
	let fuzzy = 0;
	const symSim = similarity(q, sym);
	if (symSim >= 0.6) fuzzy = Math.max(fuzzy, Math.round(symSim * 200));
	for (const w of words) {
		if (Math.abs(w.length - q.length) > 2) continue;
		const s = similarity(q, w);
		if (s >= 0.7) fuzzy = Math.max(fuzzy, Math.round(s * 150));
	}
	if (fuzzy === 0 && q.length >= 3 && isSubsequence(q, sym)) fuzzy = 120;
	return fuzzy;
}

/**
 * Case-insensitive substring + simple fuzzy search over symbol and company name.
 * Returns the best matches, highest score first, ties broken alphabetically.
 */
export function searchSymbols(entries: SymbolEntry[], query: string, limit = 5): SymbolEntry[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];

	const scored: { entry: SymbolEntry; score: number }[] = [];
	for (const entry of entries) {
		const score = scoreEntry(q, entry);
		if (score > 0) scored.push({ entry, score });
	}

	scored.sort((a, b) => b.score - a.score || a.entry.symbol.localeCompare(b.entry.symbol));
	return scored.slice(0, limit).map((s) => s.entry);
}

export type SymbolMatches = {
	matches: SymbolEntry[];
	/** When the underlying symbol list was last refreshed (ISO), or null. */
	updatedAt: string | null;
};

/**
 * Load the symbol list from KV and return the top matches for `query`, along
 * with when the list was last refreshed. `limit` is capped at 25.
 */
export async function getSymbolMatches(
	store: CacheStore,
	query: string,
	limit = 5,
): Promise<SymbolMatches> {
	const { symbols, updatedAt } = await loadSymbolStore(store);
	return { matches: searchSymbols(symbols, query, Math.min(limit, 25)), updatedAt };
}
