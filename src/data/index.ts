export {
	BROWSER_UA,
	DataError,
	DEFAULT_TIMEOUT_MS,
	fetchJson,
	isDataError,
	type DataErrorCode,
	type FetchJsonOptions,
} from "./http";

export {
	epochSecondsToIso,
	fetchChart,
	getQuote,
	mapQuote,
	normalizeSymbol,
	toYahooSymbol,
	YAHOO_CHART_BASE,
	type Quote,
	type YahooChartMeta,
	type YahooChartResponse,
} from "./quotes";

export {
	getIndex,
	getIndices,
	INDEX_KEYS,
	NSE_INDICES,
	type IndexFailure,
	type IndexKey,
	type IndexQuote,
} from "./indices";

export {
	getAnnouncements,
	mapAnnouncement,
	mapAnnouncements,
	NSE_ANNOUNCEMENTS_URL,
	parseAnnouncementDate,
	type Announcement,
	type RawAnnouncement,
} from "./announcements";

export {
	getMarketStatus,
	HEADLINE_SEGMENT,
	mapMarketSegment,
	mapMarketStatus,
	normalizeStatus,
	NSE_MARKET_STATUS_URL,
	type MarketSegment,
	type MarketStatus,
	type MarketStatusValue,
	type RawMarketState,
} from "./status";
