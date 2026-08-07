/**
 * Parsing for NSE's "dd-Mon-yyyy" date strings, which appear both with a time
 * (announcements: "06-Aug-2026 22:04:15") and without (corporate-action
 * ex-dates: "05-Jun-2026"). NSE publishes these in IST with no offset attached.
 */

const MONTHS: Record<string, string> = {
	JAN: "01",
	FEB: "02",
	MAR: "03",
	APR: "04",
	MAY: "05",
	JUN: "06",
	JUL: "07",
	AUG: "08",
	SEP: "09",
	OCT: "10",
	NOV: "11",
	DEC: "12",
};

const NSE_DATE_RE = /^(\d{2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?$/;

/**
 * Parse an NSE date.
 *
 * With a time component, returns a full ISO 8601 string with the +05:30 IST
 * offset ("2026-08-06T22:04:15+05:30"). Date-only input returns a plain
 * "YYYY-MM-DD". Returns null for anything unparseable.
 */
export function parseNseDate(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const s = value.trim();
	if (!s) return null;
	const m = NSE_DATE_RE.exec(s);
	if (!m) return null;
	const month = MONTHS[m[2].toUpperCase()];
	if (!month) return null;

	const date = `${m[3]}-${month}-${m[1]}`;
	if (m[4]) {
		const iso = `${date}T${m[4]}:${m[5]}:${m[6]}+05:30`;
		return Number.isNaN(new Date(iso).getTime()) ? null : iso;
	}
	// Validate the calendar date, but return it without a spurious time/offset.
	return Number.isNaN(new Date(`${date}T00:00:00+05:30`).getTime()) ? null : date;
}
