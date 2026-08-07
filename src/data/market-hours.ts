/**
 * NSE trading-hours arithmetic, used to pick cache TTLs.
 *
 * Workers run in UTC, so IST is derived by offset rather than by asking the
 * runtime for a local time. India has no daylight saving, so a fixed +05:30
 * is exact — unlike most timezones, this shortcut is safe here.
 *
 * Holidays are NOT modelled. On an NSE holiday this reports "market hours"
 * during the usual window, which only means quotes are refreshed more often
 * than necessary — the data is still correct, just less cached.
 */

/** IST is UTC+05:30 year-round. */
export const IST_OFFSET_MINUTES = 330;

/** 09:15 IST, as minutes past midnight. */
export const MARKET_OPEN_MINUTES = 9 * 60 + 15;

/** 15:30 IST, as minutes past midnight. */
export const MARKET_CLOSE_MINUTES = 15 * 60 + 30;

const MINUTES_PER_DAY = 24 * 60;

export type IstParts = {
	/** 0 = Sunday … 6 = Saturday, in IST. */
	day: number;
	/** Minutes past IST midnight. */
	minutes: number;
	/** Seconds elapsed within the current minute. */
	secondsIntoMinute: number;
};

export function istParts(now: Date): IstParts {
	const ist = new Date(now.getTime() + IST_OFFSET_MINUTES * 60_000);
	return {
		day: ist.getUTCDay(),
		minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes(),
		secondsIntoMinute: ist.getUTCSeconds(),
	};
}

function isWeekday(day: number): boolean {
	return day >= 1 && day <= 5;
}

/**
 * True between 09:15 and 15:30 IST, Monday to Friday.
 *
 * The close is exclusive: at exactly 15:30 the session has ended, which also
 * keeps this consistent with {@link secondsUntilNextBoundary}.
 */
export function isMarketHours(now: Date): boolean {
	const { day, minutes } = istParts(now);
	return isWeekday(day) && minutes >= MARKET_OPEN_MINUTES && minutes < MARKET_CLOSE_MINUTES;
}

/**
 * Seconds until {@link isMarketHours} would next flip.
 *
 * Used to stop a cached market status outliving the open or close it describes.
 */
export function secondsUntilNextBoundary(now: Date): number {
	const { day, minutes, secondsIntoMinute } = istParts(now);
	const partialMinute = secondsIntoMinute > 0 ? 60 - secondsIntoMinute : 0;
	const wholeMinutes = (target: number) => (target - minutes - (partialMinute > 0 ? 1 : 0)) * 60;

	if (isWeekday(day)) {
		if (minutes < MARKET_OPEN_MINUTES) return wholeMinutes(MARKET_OPEN_MINUTES) + partialMinute;
		if (minutes < MARKET_CLOSE_MINUTES)
			return wholeMinutes(MARKET_CLOSE_MINUTES) + partialMinute;
	}

	// After the close, or on a weekend: the next boundary is the next weekday open.
	let daysAhead = 1;
	while (!isWeekday((day + daysAhead) % 7)) daysAhead++;
	const target = daysAhead * MINUTES_PER_DAY + MARKET_OPEN_MINUTES;
	return wholeMinutes(target) + partialMinute;
}
