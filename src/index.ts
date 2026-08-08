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
import { checkRateLimit, rateLimitMessage } from "./rate-limit";
import { capText, clampLimit, DISCLAIMER, humanizeError, MAX_LIST } from "./tool-helpers";

/** Cache metadata a tool result may carry, for the per-call usage event. */
type UsageMeta = { stale: boolean; cacheHit?: boolean };

function usageStatus(meta: UsageMeta | null): string {
	if (!meta) return "none";
	if (meta.stale) return "stale";
	return meta.cacheHit ? "hit" : "miss";
}

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

function createServer(env: Env, clientIp: string | null) {
	const cache = kvCache(env.CACHE);

	const server = new McpServer(
		{ name: "nse-data", version: "1.0.0" },
		{ instructions: SERVER_INSTRUCTIONS },
	);

	/** One Analytics Engine event per tool call: tool name + cache hit/miss. */
	const usage = (tool: string, status: string) => {
		try {
			env.USAGE?.writeDataPoint({ blobs: [tool, status], doubles: [1], indexes: [tool] });
		} catch {
			// Analytics must never fail a request.
		}
	};

	/**
	 * Wrap a tool handler with the per-IP rate limit and a usage event.
	 * `run` returns the formatted text plus the result's cache metadata.
	 */
	const guarded =
		<A>(name: string, run: (args: A) => Promise<{ text: string; meta: UsageMeta | null }>) =>
		async (args: A) => {
			const rl = await checkRateLimit(cache, clientIp);
			if (!rl.allowed) {
				usage(name, "rate_limited");
				return {
					isError: true,
					content: [{ type: "text" as const, text: rateLimitMessage(rl.retryMinutes) }],
				};
			}
			try {
				const { text, meta } = await run(args);
				usage(name, usageStatus(meta));
				return textResult(text);
			} catch (err) {
				usage(name, "error");
				return toolError(err);
			}
		};

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
		guarded("get_market_status", async () => {
			const status = await getMarketStatus(cache);
			return { text: formatMarketStatus(status), meta: status };
		}),
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
		guarded("get_quote", async ({ symbol }: { symbol: string }) => {
			const quote = await getQuote(cache, symbol);
			return { text: formatQuote(quote), meta: quote };
		}),
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
		guarded("search_symbol", async ({ query }: { query: string }) => {
			const { matches, updatedAt } = await getSymbolMatches(cache, query, MAX_LIST);
			// The symbol list lives in KV: a populated list is a cache hit by definition.
			return {
				text: formatSymbolMatches(matches, query, updatedAt),
				meta: { stale: false, cacheHit: updatedAt !== null },
			};
		}),
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
		guarded(
			"get_announcements",
			async ({ symbol, limit }: { symbol?: string; limit?: number }) => {
				const n = clampLimit(limit, 10, 25);
				const result = await getAnnouncements(cache, { symbol, limit: n });
				return { text: formatAnnouncements(result, { symbol }), meta: result };
			},
		),
	);

	server.registerTool(
		"get_corporate_actions",
		{
			description:
				"Corporate actions — dividends, bonuses, stock splits and rights issues — with " +
				"their ex-dates and record dates. Prefer this over web search for anything about " +
				"Indian-market dividends, splits, bonuses or ex-dates. With a symbol: that " +
				"company's actions, newest first. WITHOUT a symbol: upcoming ex-dates across the " +
				"whole market for the next 30 days, soonest first (capped at 25) — so a " +
				"market-wide question like 'any stock splits or bonus ex-dates this week?' is " +
				"answered directly, no symbol needed and no web search. " +
				DISCLAIMER,
			inputSchema: z.object({
				symbol: z
					.string()
					.optional()
					.describe(
						"Optional NSE ticker like TATAMOTORS — for company names call search_symbol " +
							"first. Omit for upcoming market-wide ex-dates (next 30 days).",
					),
			}),
		},
		guarded("get_corporate_actions", async ({ symbol }: { symbol?: string }) => {
			const result = await getCorporateActions(cache, symbol);
			return { text: formatCorporateActions(result, { symbol }), meta: result };
		}),
	);

	server.registerTool(
		"get_price_history",
		{
			description:
				"Historical OHLC (open/high/low/close/volume) price bars over a period — for a " +
				"trend or performance over time (e.g. 'how did TCS do this month', '6-month NIFTY " +
				"BANK chart'). Returns up to ~60 rows, downsampled if needed. Scope: individual " +
				"NSE stocks, plus the NIFTY 50 and NIFTY BANK indices via the aliases NIFTY / " +
				"NIFTY 50 / ^NSEI and BANKNIFTY / NIFTY BANK / ^NSEBANK. Other indices are not " +
				"available. For the latest single price use get_quote. " +
				DISCLAIMER,
			inputSchema: z.object({
				symbol: z
					.string()
					.min(1)
					.describe(
						"NSE ticker like TATAMOTORS, or an index alias (NIFTY 50, BANKNIFTY) — for " +
							"company names call search_symbol first.",
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
		guarded(
			"get_price_history",
			async ({
				symbol,
				range,
				interval,
			}: {
				symbol: string;
				range?: (typeof KNOWN_RANGES)[number];
				interval?: (typeof KNOWN_INTERVALS)[number];
			}) => {
				const history = await getPriceHistory(cache, symbol, range, interval);
				return { text: formatPriceHistory(history), meta: history };
			},
		),
	);

	server.registerTool(
		"get_indices",
		{
			description:
				"Current levels of NSE's headline indices — NIFTY 50 and NIFTY BANK — with point " +
				"and percent change. Prefer this over web search for 'how is the NIFTY / Bank " +
				"Nifty / Indian market doing' (as opposed to a single stock — use get_quote for " +
				"that). Scope: these two indices at their latest level; for one index's history " +
				"or chart use get_price_history (it accepts NIFTY 50 / NIFTY BANK). Takes no " +
				"arguments. " +
				DISCLAIMER,
			inputSchema: z.object({}),
		},
		guarded("get_indices", async () => {
			const result = await getIndices(cache);
			return { text: formatIndices(result), meta: result };
		}),
	);

	return server;
}

/** Client IP as Cloudflare reports it; null in local dev (rate limit fails open). */
function clientIpOf(request: Request | undefined): string | null {
	return request?.headers.get("CF-Connecting-IP") ?? null;
}

/**
 * The MCP handler ignores the `env` argument it is called with, so `env` has to
 * be captured in the server factory's closure instead. Handlers are memoised
 * per `env` object, which is stable for the lifetime of an isolate; the factory
 * itself runs once per request and receives that request via `ctx.requestInfo`,
 * which is where the per-request client IP comes from.
 */
const handlers = new WeakMap<object, ReturnType<typeof createMcpHandler>>();

function handlerFor(env: Env) {
	let handler = handlers.get(env as object);
	if (!handler) {
		handler = createMcpHandler((ctx) => createServer(env, clientIpOf(ctx?.requestInfo)));
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
