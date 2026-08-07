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
	cacheKey,
	kvCache,
	quoteTtlSeconds,
	STALE_RETENTION_SECONDS,
	statusTtlSeconds,
	TTL_DEFAULT_SECONDS,
	TTL_MARKET_HOURS_SECONDS,
	withCache,
	type Cached,
	type CacheMeta,
	type CacheStore,
} from "./cache";

export {
	IST_OFFSET_MINUTES,
	isMarketHours,
	istParts,
	MARKET_CLOSE_MINUTES,
	MARKET_OPEN_MINUTES,
	secondsUntilNextBoundary,
} from "./market-hours";

export {
	epochSecondsToIso,
	fetchChart,
	fetchQuote,
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
	fetchIndex,
	fetchIndices,
	getIndex,
	getIndices,
	INDEX_KEYS,
	NSE_INDICES,
	type IndexFailure,
	type IndexKey,
	type IndexQuote,
	type IndicesResult,
} from "./indices";

export {
	fetchAnnouncements,
	getAnnouncements,
	mapAnnouncement,
	mapAnnouncements,
	NSE_ANNOUNCEMENTS_URL,
	parseAnnouncementDate,
	type Announcement,
	type AnnouncementsResult,
	type RawAnnouncement,
} from "./announcements";

export {
	EQUITY_L_URL,
	getSymbolMatches,
	loadSymbols,
	parseEquityCsv,
	refreshSymbols,
	searchSymbols,
	type SymbolEntry,
} from "./symbols";

export {
	fetchMarketStatus,
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
