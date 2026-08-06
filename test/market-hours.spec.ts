import { describe, expect, it } from "vitest";
import {
	isMarketHours,
	istParts,
	secondsUntilNextBoundary,
} from "../src/data/market-hours";

/** Build a Date from an IST wall-clock time. IST is UTC+05:30. */
function ist(iso: string): Date {
	return new Date(`${iso}+05:30`);
}

// 2026-08-03 is a Monday; 2026-08-08 a Saturday; 2026-08-09 a Sunday.
describe("istParts", () => {
	it("converts UTC to IST wall clock", () => {
		const p = istParts(new Date("2026-08-03T04:00:00Z"));
		expect(p.minutes).toBe(9 * 60 + 30); // 09:30 IST
		expect(p.day).toBe(1); // Monday
	});

	it("rolls the day over when IST is ahead of UTC", () => {
		const p = istParts(new Date("2026-08-03T19:00:00Z")); // 00:30 IST Tuesday
		expect(p.day).toBe(2);
		expect(p.minutes).toBe(30);
	});
});

describe("isMarketHours", () => {
	it.each([
		["2026-08-03T09:15:00", true, "Monday at the open"],
		["2026-08-03T12:00:00", true, "Monday midday"],
		["2026-08-03T15:29:59", true, "Monday just before close"],
		["2026-08-07T11:00:00", true, "Friday midday"],
	])("%s → open (%s)", (t, expected) => {
		expect(isMarketHours(ist(t))).toBe(expected);
	});

	it.each([
		["2026-08-03T09:14:59", "Monday just before the open"],
		["2026-08-03T15:30:00", "Monday at the close (session over)"],
		["2026-08-03T18:00:00", "Monday evening"],
		["2026-08-03T03:00:00", "Monday small hours"],
		["2026-08-08T12:00:00", "Saturday midday"],
		["2026-08-09T12:00:00", "Sunday midday"],
	])("%s → closed (%s)", (t) => {
		expect(isMarketHours(ist(t))).toBe(false);
	});
});

describe("secondsUntilNextBoundary", () => {
	it("counts to the open before trading starts", () => {
		expect(secondsUntilNextBoundary(ist("2026-08-03T09:00:00"))).toBe(15 * 60);
	});

	it("counts to the close during trading", () => {
		expect(secondsUntilNextBoundary(ist("2026-08-03T15:00:00"))).toBe(30 * 60);
	});

	it("counts to tomorrow's open after the close on a weekday", () => {
		// Mon 16:00 → Tue 09:15 is 17h15m.
		expect(secondsUntilNextBoundary(ist("2026-08-03T16:00:00"))).toBe((17 * 60 + 15) * 60);
	});

	it("skips the weekend from Friday evening", () => {
		// Fri 16:00 → Mon 09:15 is 65h15m.
		expect(secondsUntilNextBoundary(ist("2026-08-07T16:00:00"))).toBe((65 * 60 + 15) * 60);
	});

	it("skips the weekend from Saturday", () => {
		// Sat 12:00 → Mon 09:15 is 45h15m.
		expect(secondsUntilNextBoundary(ist("2026-08-08T12:00:00"))).toBe((45 * 60 + 15) * 60);
	});

	it("handles partial minutes without going negative", () => {
		const s = secondsUntilNextBoundary(ist("2026-08-03T09:14:30"));
		expect(s).toBe(30);
	});

	it("is always positive", () => {
		for (const t of [
			"2026-08-03T09:15:00",
			"2026-08-03T15:29:59",
			"2026-08-03T15:30:00",
			"2026-08-08T23:59:59",
		]) {
			expect(secondsUntilNextBoundary(ist(t))).toBeGreaterThan(0);
		}
	});
});
