import { describe, expect, it } from "vitest";
import { parseNseDate } from "../src/data/dates";

describe("parseNseDate", () => {
	it("parses a date+time as IST ISO 8601", () => {
		expect(parseNseDate("06-Aug-2026 22:04:15")).toBe("2026-08-06T22:04:15+05:30");
	});

	it("parses a date-only value as plain YYYY-MM-DD (no time, no offset)", () => {
		expect(parseNseDate("05-Jun-2026")).toBe("2026-06-05");
		expect(parseNseDate("28-Oct-2024")).toBe("2024-10-28");
	});

	it("is case-insensitive about the month", () => {
		expect(parseNseDate("01-JAN-2026")).toBe("2026-01-01");
		expect(parseNseDate("31-dec-2025 23:59:59")).toBe("2025-12-31T23:59:59+05:30");
	});

	it("date-only values sort lexicographically in calendar order", () => {
		const dates = ["05-Jun-2026", "14-Aug-2025", "28-Oct-2024"].map((d) => parseNseDate(d)!);
		expect([...dates].sort()).toEqual(["2024-10-28", "2025-08-14", "2026-06-05"]);
	});

	it.each([null, undefined, "", "2026-08-06", "6-Aug-2026", "06-Xxx-2026", "06-Aug-26", 42])(
		"returns null for unparseable %j",
		(v) => {
			expect(parseNseDate(v)).toBeNull();
		},
	);
});
