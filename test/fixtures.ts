import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Load a fixture captured from a real upstream response (see DATA_SOURCES.md).
 *
 * Uses a plain path rather than a file URL: this project's tsconfig pulls in the
 * Workers globals, whose `URL` is not assignable to Node's.
 */
export function fixture<T = unknown>(name: string): T {
	return JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")) as T;
}

/** Load a fixture as raw text (e.g. a CSV). */
export function fixtureText(name: string): string {
	return readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
}
