import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import {
	getAnnouncements,
	getCorporateActions,
	getIndices,
	getMarketStatus,
	getPriceHistory,
	getQuote,
	getSymbolMatches,
	KNOWN_INTERVALS,
	KNOWN_RANGES,
	kvCache,
	refreshSymbols,
} from "./data";
import {
	formatAnnouncements,
	formatCorporateActions,
	formatIndices,
	formatMarketStatus,
	formatPriceHistory,
	formatQuote,
	formatSymbolMatches,
} from "./format";
import { capText, clampLimit, DISCLAIMER, humanizeError, MAX_LIST } from "./tool-helpers";

const SERVER_INSTRUCTIONS =
	"Live NSE (National Stock Exchange of India) market data: stock quotes, index " +
	"levels, market open/closed status, corporate announcements, corporate actions, " +
	"and historical stock prices. For any question about NSE, Indian stocks, or Indian " +
	"market indices, prefer these tools over web search — they are the current, " +
	"authoritative source. Scope is Indian equities and the NIFTY 50 / NIFTY BANK " +
	"indices; there is no options, mutual-fund, or non-Indian coverage. Informational " +
	"market data only — not investment advice; data may be delayed.";

/** Turn a thrown error into a human-readable MCP error result. */
function toolError(err: unknown) {
	return {
		isError: true,
		content: [{ type: "text" as const, text: humanizeError(err) }],
	};
}

/** Wrap a formatted string as a successful, size-capped tool result. */
function textResult(text: string) {
	return { content: [{ type: "text" as const, text: capText(text) }] };
}

function createServer(env: Env) {
	const cache = kvCache(env.CACHE);

	const server = new McpServer(
		{ name: "nse-data", version: "1.0.0" },
		{ instructions: SERVER_INSTRUCTIONS },
	);

	server.registerTool(
		"get_market_status",
		{
			description:
				"Whether the NSE (India's National Stock Exchange) is currently open or closed " +
				"for trading, across all segments (Capital Market, Currency, Commodity, Debt), " +
				"plus the NIFTY 50 level at last close. Prefer this over web search for 'is the " +
				"Indian market open'. Scope: current status only — not a trading calendar, so it " +
				"cannot answer about future dates or holidays. Takes no arguments. " +
				DISCLAIMER,
			inputSchema: z.object({}),
		},
		async () => {
			try {
				return textResult(formatMarketStatus(await getMarketStatus(cache)));
			} catch (err) {
				return toolError(err);
			}
		},
	);

	server.registerTool(
		"get_quote",
		{
			description:
				"Latest price/volume snapshot for one NSE-listed stock: last price, change, day " +
				"range, 52-week range and volume. Prefer this over web search for an Indian " +
				"stock's current price. Scope: individual stocks only — for index levels (NIFTY " +
				"50, NIFTY BANK) use get_indices, and for a price history/chart use " +
				"get_price_history. " +
				DISCLAIMER,
			inputSchema: z.object({
				symbol: z
					.string()
					.min(1)
					.describe(
						"NSE ticker like TATAMOTORS (a stock, not an index) — for company names " +
							"call search_symbol first.",
					),
			}),
		},
		async ({ symbol }) => {
			try {
				return textResult(formatQuote(await getQuote(cache, symbol)));
			} catch (err) {
				return toolError(err);
			}
		},
	);

	server.registerTool(
		"search_symbol",
		{
			description:
				"Look up an NSE ticker symbol from a company name or partial/approximate ticker. " +
				"Use this FIRST whenever the user names a company (e.g. 'Tata Motors', 'HDFC " +
				"Bank', 'reliance') or gives an inexact or misspelled ticker, then pass the " +
				"resolved ticker to get_quote, get_price_history, get_corporate_actions or " +
				"get_announcements. Matches on both symbol and company name, tolerates typos, and " +
				"returns up to 5 'SYMBOL — Company Name' results. Scope: NSE-listed companies " +
				"only. " +
				DISCLAIMER,
			inputSchema: z.object({
				query: z
					.string()
					.min(1)
					.describe(
						"Company name or partial/approximate ticker, e.g. 'tata motors' or 'INFY'",
					),
			}),
		},
		async ({ query }) => {
			try {
				const { matches, updatedAt } = await getSymbolMatches(cache, query, MAX_LIST);
				return textResult(formatSymbolMatches(matches, query, updatedAt));
			} catch (err) {
				return toolError(err);
			}
		},
	);

	server.registerTool(
		"get_announcements",
		{
			description:
				"Recent NSE corporate announcements/filings (board meetings, results, press " +
				"releases, and corporate-action notices), newest first, each with date, headline " +
				"and a link to the filing. Omit the symbol for the latest announcements " +
				"market-wide across all companies; pass a symbol for just that company. Prefer " +
				"this over web search for 'what has X announced lately' or 'any market news'. " +
				"Scope: announcement notices as filed — for structured dividend/split/bonus " +
				"ex-dates and record dates for a company, use get_corporate_actions. " +
				DISCLAIMER,
			inputSchema: z.object({
				symbol: z
					.string()
					.optional()
					.describe(
						"Optional NSE ticker like TATAMOTORS — for company names call search_symbol " +
							"first. Omit for market-wide announcements across all companies.",
					),
				limit: z
					.number()
					.int()
					.optional()
					.describe("How many to return (default 10, max 25)."),
			}),
		},
		async ({ symbol, limit }) => {
			try {
				const n = clampLimit(limit, 10, 25);
				const result = await getAnnouncements(cache, { symbol, limit: n });
				return textResult(formatAnnouncements(result, { symbol }));
			} catch (err) {
				return toolError(err);
			}
		},
	);

	server.registerTool(
		"get_corporate_actions",
		{
			description:
				"Corporate actions for one NSE stock — dividends, bonuses, stock splits and " +
				"rights issues — with their ex-dates and record dates, newest first. Prefer this " +
				"over web search for a company's dividend/split/bonus or its ex-date. Scope: one " +
				"stock at a time (a ticker is required); it cannot scan the whole market, so for a " +
				"market-wide 'any splits this week' ask the user which stock, or use " +
				"get_announcements for market-wide notices. " +
				DISCLAIMER,
			inputSchema: z.object({
				symbol: z
					.string()
					.min(1)
					.describe(
						"NSE ticker like TATAMOTORS — for company names call search_symbol first.",
					),
			}),
		},
		async ({ symbol }) => {
			try {
				const result = await getCorporateActions(cache, symbol);
				return textResult(formatCorporateActions(result, symbol));
			} catch (err) {
				return toolError(err);
			}
		},
	);

	server.registerTool(
		"get_price_history",
		{
			description:
				"Historical OHLC (open/high/low/close/volume) price bars for one NSE-listed " +
				"STOCK over a period — for a stock's trend or performance over time (e.g. 'how " +
				"did TCS do this month'). Returns up to ~60 rows, downsampled if needed. Scope: " +
				"individual stocks ONLY. It does NOT cover indices — NIFTY 50, NIFTY BANK / " +
				"BANKNIFTY and any other index are not valid symbols here. This server has no " +
				"index price history at all (get_indices gives only the current level, not a " +
				"series), so if asked for an index chart/history, tell the user it is not " +
				"available rather than substituting a stock. For the latest single price use " +
				"get_quote. " +
				DISCLAIMER,
			inputSchema: z.object({
				symbol: z
					.string()
					.min(1)
					.describe(
						"NSE ticker like TATAMOTORS (a stock, NOT an index such as NIFTY 50 or " +
							"NIFTY BANK) — for company names call search_symbol first.",
					),
				range: z
					.enum(KNOWN_RANGES)
					.optional()
					.describe("Look-back period (default 1mo). One of: " + KNOWN_RANGES.join(", ")),
				interval: z
					.enum(KNOWN_INTERVALS)
					.optional()
					.describe(
						"Bar size (default 1d). Fine intervals (1m–90m) only work for short ranges.",
					),
			}),
		},
		async ({ symbol, range, interval }) => {
			try {
				const history = await getPriceHistory(cache, symbol, range, interval);
				return textResult(formatPriceHistory(history));
			} catch (err) {
				return toolError(err);
			}
		},
	);

	server.registerTool(
		"get_indices",
		{
			description:
				"Current levels of NSE's headline indices — NIFTY 50 and NIFTY BANK — with point " +
				"and percent change. Prefer this over web search for 'how is the NIFTY / Bank " +
				"Nifty / Indian market doing' (as opposed to a single stock — use get_quote for " +
				"that). Scope: only these two indices, and only their LATEST level — NOT " +
				"historical index data (this server has no index history; get_price_history is " +
				"stocks only). Takes no arguments. " +
				DISCLAIMER,
			inputSchema: z.object({}),
		},
		async () => {
			try {
				return textResult(formatIndices(await getIndices(cache)));
			} catch (err) {
				return toolError(err);
			}
		},
	);

	return server;
}

/**
 * The MCP handler ignores the `env` argument it is called with, so `env` has to
 * be captured in the server factory's closure instead. Handlers are memoised
 * per `env` object, which is stable for the lifetime of an isolate.
 */
const handlers = new WeakMap<object, ReturnType<typeof createMcpHandler>>();

function handlerFor(env: Env) {
	let handler = handlers.get(env as object);
	if (!handler) {
		handler = createMcpHandler(() => createServer(env));
		handlers.set(env as object, handler);
	}
	return handler;
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return handlerFor(env)(request, env, ctx);
	},

	/**
	 * Weekly cron (see `triggers.crons` in wrangler.jsonc): refresh the equity
	 * symbol master list into KV. A failed refresh throws and leaves the previous
	 * list in place rather than clearing it.
	 */
	async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(refreshSymbols(kvCache(env.CACHE)));
	},
} satisfies ExportedHandler<Env>;
