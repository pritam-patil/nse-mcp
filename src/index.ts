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
		"get_quote",
		{
			description:
				"Latest NSE price/volume snapshot for one Indian stock symbol like RELIANCE or " +
				"TCS. Returns last price, change, day range, 52-week range and volume. Use the " +
				"plain NSE symbol without any suffix (RELIANCE, not RELIANCE.NS). For index " +
				"levels like NIFTY 50 use get_indices instead. " +
				DISCLAIMER,
			inputSchema: z.object({
				symbol: z
					.string()
					.min(1)
					.describe("NSE stock symbol, e.g. RELIANCE, TCS, INFY, HDFCBANK"),
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
				"Find an NSE stock's ticker symbol by company name or partial symbol. Use when the " +
				"user names a company but not its exact symbol (e.g. 'Reliance', 'HDFC bank', " +
				"'tata motors') before calling get_quote. Matches on both symbol and company name, " +
				"tolerates typos, and returns up to 5 'SYMBOL — Company Name' results. " +
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
				"a symbol for one company's announcements, or omit it for the latest across the " +
				"whole market. Use when asked what a company has announced or filed lately. " +
				DISCLAIMER,
			inputSchema: z.object({
				symbol: z
					.string()
					.optional()
					.describe(
						"Optional NSE symbol, e.g. RELIANCE. Omit for market-wide announcements.",
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
				"Corporate actions for one NSE stock — dividends, bonuses, stock splits, rights " +
				"issues — with their ex-dates and record dates, newest first. Use when asked about " +
				"a company's dividend, bonus, split, or upcoming/past ex-date. " +
				DISCLAIMER,
			inputSchema: z.object({
				symbol: z.string().min(1).describe("NSE stock symbol, e.g. RELIANCE, TCS, ITC"),
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
				"Historical OHLC (open/high/low/close/volume) price bars for one NSE stock over a " +
				"period. Use for trends or comparing performance over time (e.g. 'how did TCS do " +
				"this month', 'RELIANCE over the last year'). Returns up to ~60 rows, downsampled " +
				"if needed. For the latest single price use get_quote instead. " +
				DISCLAIMER,
			inputSchema: z.object({
				symbol: z.string().min(1).describe("NSE stock symbol, e.g. RELIANCE, TCS"),
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
				"point and percent change. Call when asked how the Indian market / NIFTY / Bank " +
				"Nifty is doing overall, as opposed to a single stock (use get_quote for that). " +
				"Takes no arguments. " +
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
