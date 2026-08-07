import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import {
	getIndices,
	getMarketStatus,
	getQuote,
	getSymbolMatches,
	isDataError,
	kvCache,
	refreshSymbols,
} from "./data";
import { formatIndices, formatMarketStatus, formatQuote, formatSymbolMatches } from "./format";

const SERVER_INSTRUCTIONS =
	"NSE (National Stock Exchange of India) market data. Informational market data " +
	"only — not investment advice; data may be delayed.";

/** Render a thrown DataError as a tool error the model can reason about. */
function toolError(err: unknown) {
	const code = isDataError(err) ? err.code : "SOURCE_UNAVAILABLE";
	const message = err instanceof Error ? err.message : String(err);
	return {
		isError: true,
		content: [{ type: "text" as const, text: `Error (${code}): ${message}` }],
	};
}

/** Wrap a formatted string as a successful tool result. */
function textResult(text: string) {
	return { content: [{ type: "text" as const, text }] };
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
				"Commodity, Debt). Takes no arguments.",
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
				"levels like NIFTY 50 use get_indices instead.",
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
				"tolerates typos, and returns up to 5 'SYMBOL — Company Name' results.",
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
				return textResult(formatSymbolMatches(await getSymbolMatches(cache, query), query));
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
				"Takes no arguments.",
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
