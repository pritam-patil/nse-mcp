import { describe, expect, it } from "vitest";
import { mapAnnouncements, parseAnnouncementDate } from "../src/data/announcements";
import { fixture } from "./fixtures";

const raw = fixture<unknown[]>("nse-announcements.json");

describe("parseAnnouncementDate", () => {
	it("reads NSE's dd-Mon-yyyy HH:mm:ss as IST", () => {
		expect(parseAnnouncementDate("06-Aug-2026 22:28:38")).toBe("2026-08-06T22:28:38+05:30");
	});

	it("is case-insensitive about the month", () => {
		expect(parseAnnouncementDate("01-JAN-2026 00:00:00")).toBe("2026-01-01T00:00:00+05:30");
		expect(parseAnnouncementDate("31-dec-2025 23:59:59")).toBe("2025-12-31T23:59:59+05:30");
	});

	it("represents the correct instant in UTC", () => {
		// 22:28:38 IST is 16:58:38 UTC.
		const iso = parseAnnouncementDate("06-Aug-2026 22:28:38");
		expect(new Date(iso!).toISOString()).toBe("2026-08-06T16:58:38.000Z");
	});

	it.each([
		null,
		undefined,
		"",
		"2026-08-06T22:28:38Z",
		"06-Xxx-2026 22:28:38",
		"6-Aug-2026 22:28:38",
		42,
	])("returns null for unparseable %j", (v) => {
		expect(parseAnnouncementDate(v)).toBeNull();
	});
});

describe("mapAnnouncements — real /api/corporate-announcements response", () => {
	const items = mapAnnouncements(raw);

	it("maps every record NSE returned", () => {
		expect(raw).toHaveLength(20);
		expect(items).toHaveLength(20);
	});

	it("maps the documented fields of the first record", () => {
		expect(items[0]).toEqual({
			symbol: "MANGLMCEM",
			company: "Mangalam Cement Limited",
			description: "Updates",
			announcedAt: "06-Aug-2026 22:28:38",
			announcedAtIso: "2026-08-06T22:28:38+05:30",
			attachmentUrl:
				"https://nsearchives.nseindia.com/corporate/MANGLMCEM_06082026222809_Intimation_to_Stock_Excahnge_01_06_2026_SOLAR_S.pdf",
			source: "nse-corporate-announcements",
		});
	});

	it("resolves a timestamp for every record", () => {
		expect(items.every((i) => i.announcedAtIso !== null)).toBe(true);
	});

	it("attaches PDF urls on nsearchives where present", () => {
		const withAttachments = items.filter((i) => i.attachmentUrl !== null);
		expect(withAttachments.length).toBeGreaterThan(0);
		expect(
			withAttachments.every((i) =>
				i.attachmentUrl!.startsWith("https://nsearchives.nseindia.com/"),
			),
		).toBe(true);
	});

	it("honours a limit", () => {
		expect(mapAnnouncements(raw, 5)).toHaveLength(5);
		expect(mapAnnouncements(raw, 0)).toHaveLength(0);
	});
});

describe("mapAnnouncements — degraded payloads", () => {
	it.each([null, undefined, {}, "nope", 42])("returns [] for non-array %j", (v) => {
		expect(mapAnnouncements(v)).toEqual([]);
	});

	it("skips non-object entries rather than throwing", () => {
		expect(mapAnnouncements([null, "x", 1, { symbol: "INFY" }])).toHaveLength(1);
	});

	it("nulls missing and blank fields", () => {
		expect(mapAnnouncements([{ symbol: "  ", desc: "" }])[0]).toMatchObject({
			symbol: null,
			company: null,
			description: null,
			announcedAt: null,
			announcedAtIso: null,
			attachmentUrl: null,
		});
	});
});
