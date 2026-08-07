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
	"NSE (National Stock Exchange of India) market data. Informational market data " +
	"only — not investment advice; data may be delayed.";

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
				"for trading. Call when asked if the Indian market / NSE is open, or for the " +
				"NIFTY 50 level at last close. Covers all segments (Capital Market, Currency, " +
				"Commodity, Debt). Takes no arguments. " +
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
		"get_stock_quote",
		{
			description:
				"Latest price/volume snapshot for ONE NSE-listed stock, identified by its EXACT " +
				"NSE ticker (RELIANCE, TCS, INFY). Returns last price, change, day range, 52-week " +
				"range and volume. Do NOT pass a company name: if the user gives a name such as " +
				"'Tata Motors' or 'Infosys' rather than a ticker, call search_symbol FIRST to " +
				"resolve the ticker, then call this. Do NOT pass an index (NIFTY 50, NIFTY BANK); " +
				"use get_indices for those. " +
				DISCLAIMER,
			inputSchema: z.object({
				symbol: z
					.string()
					.min(1)
					.describe(
						"Exact NSE ticker symbol (RELIANCE, TCS, INFY, HDFCBANK) — a stock ticker, " +
							"not a company name and not an index. If you only have a company name, " +
							"resolve it with search_symbol first.",
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
				"Resolve a company name or partial/approximate ticker to its exact NSE ticker " +
				"symbol. Call this FIRST whenever the user names a company (e.g. 'Tata Motors', " +
				"'HDFC bank', 'reliance') or gives an inexact or misspelled ticker, before " +
				"get_stock_quote, get_stock_price_history, get_corporate_actions or " +
				"get_announcements — those all require an exact ticker. Matches on symbol and " +
				"company name, tolerates typos, returns up to 5 'SYMBOL — Company Name' results. " +
				DISCLAIMER,
			inputSchema: z.object({
				query: z
					.string()
					.min(1)
					.describe(
						"Company name or partial/approximate symbol, e.g. 'reliance' or 'INFY'",
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
				"Recent NSE corporate announcements (filings, board meetings, results, press " +
				"releases), newest first, each with date, headline and a link to the filing. Pass " +
				"an exact ticker for one company, or omit it for the latest across the whole " +
				"market. Use when asked what a company has announced or filed lately. For a " +
				"company's scheduled dividend / split / bonus EX-DATES use get_corporate_actions " +
				"instead. If the user gives a company name, resolve it with search_symbol first. " +
				DISCLAIMER,
			inputSchema: z.object({
				symbol: z
					.string()
					.optional()
					.describe(
						"Optional exact NSE ticker, e.g. RELIANCE. Omit for market-wide " +
							"announcements. Resolve a company name with search_symbol first.",
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
				"Corporate actions — dividends, bonuses, stock splits and rights issues — with " +
				"their ex-dates and record dates, for ONE NSE stock. This is the authoritative " +
				"source for a company's dividend/split/bonus ex-dates; use it rather than web " +
				"search. A ticker is REQUIRED and it covers one stock at a time — it canNOT scan " +
				"the whole market, so if the user asks market-wide (e.g. 'any stock splits or " +
				"bonus ex-dates this week?') without naming a company, ask them which stock to " +
				"check instead of guessing or searching the web. If given a company name, resolve " +
				"it with search_symbol first. " +
				DISCLAIMER,
			inputSchema: z.object({
				symbol: z
					.string()
					.min(1)
					.describe(
						"Exact NSE ticker symbol, e.g. RELIANCE, TCS, ITC. Required — one stock at " +
							"a time, not a market-wide scan. Resolve a company name with search_symbol first.",
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
		"get_stock_price_history",
		{
			description:
				"Historical OHLC (open/high/low/close/volume) price bars for ONE NSE-listed STOCK, " +
				"by its exact ticker (RELIANCE, TCS). Use for a stock's trend or performance over " +
				"time (e.g. 'how did TCS do this month', 'RELIANCE over the last year'). Returns " +
				"up to ~60 rows, downsampled if needed. STOCKS ONLY — this does NOT support " +
				"indices: NIFTY 50, NIFTY BANK / BANKNIFTY and other indices are not valid here, " +
				"and get_indices returns only their current level, not history, so index price " +
				"history is not available from this server (say so rather than substituting a " +
				"stock). If the user gives a company name, resolve it with search_symbol first. " +
				"For the latest single price use get_stock_quote. " +
				DISCLAIMER,
			inputSchema: z.object({
				symbol: z
					.string()
					.min(1)
					.describe(
						"Exact NSE STOCK ticker, e.g. RELIANCE or TCS — NOT an index (NIFTY 50, " +
							"NIFTY BANK) and NOT a company name.",
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
				"Current levels of NSE's headline indices — NIFTY 50 and NIFTY BANK — with " +
				"point and percent change. Returns the LATEST level only, NOT historical index " +
				"data (this server has no index price history — get_stock_price_history is for " +
				"individual stocks, not indices). Call when asked how the Indian market / NIFTY / " +
				"Bank Nifty is doing overall, as opposed to a single stock (use get_stock_quote " +
				"for that). Takes no arguments. " +
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
