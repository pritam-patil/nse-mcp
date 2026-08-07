/**
 * Presentation-layer guards shared by the tool handlers: the disclaimer, list
 * and response-size caps, limit clamping, and turning errors into plain English.
 * Kept out of index.ts so they can be unit-tested without loading the MCP SDK.
 */

import { isDataError } from "./data";

/** Appended to every tool description so the disclaimer travels with each tool. */
export const DISCLAIMER = "Informational data only — not investment advice; may be delayed.";

/** Hard limit on any single list output. */
export const MAX_LIST = 25;

/** Byte budget for a tool response body, a backstop against oversized output. */
export const MAX_RESPONSE_BYTES = 4096;

/** Clamp a caller-supplied limit into [1, max] with a default. */
export function clampLimit(value: number | undefined, fallback: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.trunc(value), 1), max);
}

/**
 * Turn any thrown error into a short, human-readable sentence.
 *
 * NOT_FOUND messages are already user-facing (bad symbol, invalid range/interval,
 * unavailable combo) and are kept, minus any internal "source:" prefix. Timeouts
 * and upstream failures collapse to a friendly, non-technical line.
 */
export function humanizeError(err: unknown): string {
	if (isDataError(err)) {
		const detail = err.message.replace(/^[a-z0-9-]+:\s*/i, "").trim();
		if (err.code === "TIMEOUT") {
			return "The data source took too long to respond. Please try again in a moment.";
		}
		if (err.code === "SOURCE_UNAVAILABLE") {
			return "The data source is temporarily unavailable. Please try again shortly.";
		}
		// NOT_FOUND
		if (/not found \(404\)|no chart data|no data found/i.test(detail)) {
			return "No data found for that symbol — check the symbol and try again.";
		}
		return detail ? detail.charAt(0).toUpperCase() + detail.slice(1) : "Not found.";
	}
	return "Something went wrong fetching the data. Please try again.";
}

/** Truncate a string to at most `maxBytes` UTF-8 bytes, never splitting a char. */
function sliceToBytes(s: string, maxBytes: number): string {
	const enc = new TextEncoder();
	let out = "";
	let used = 0;
	for (const ch of s) {
		const n = enc.encode(ch).length;
		if (used + n > maxBytes) break;
		out += ch;
		used += n;
	}
	return out;
}

/** Keep a response within the byte budget, trimming whole lines and noting it. */
export function capText(text: string, maxBytes = MAX_RESPONSE_BYTES): string {
	const enc = new TextEncoder();
	if (enc.encode(text).length <= maxBytes) return text;
	const note = "\n… (output trimmed to fit; narrow your request for more)";
	const budget = maxBytes - enc.encode(note).length;
	const lines = text.split("\n");
	const kept: string[] = [];
	let used = 0;
	for (const line of lines) {
		const size = enc.encode(line + "\n").length;
		if (used + size > budget) break;
		kept.push(line);
		used += size;
	}
	// Fallback for a single over-budget line: slice by bytes, not characters.
	return (kept.length ? kept.join("\n") : sliceToBytes(text, budget)) + note;
}
