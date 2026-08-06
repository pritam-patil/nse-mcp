import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { getMarketStatus, isDataError, kvCache } from "./data";

/** Render a thrown DataError as a tool error the model can reason about. */
function toolError(err: unknown) {
	const code = isDataError(err) ? err.code : "SOURCE_UNAVAILABLE";
	const message = err instanceof Error ? err.message : String(err);
	return {
		isError: true,
		content: [{ type: "text" as const, text: JSON.stringify({ error: code, message }) }],
	};
}

function createServer(env: Env) {
	const cache = kvCache(env.CACHE);

	const server = new McpServer({
		name: "nse-data",
		version: "1.0.0",
	});

	server.registerTool(
		"get_market_status",
		{
			description:
				"Get the current trading status of the NSE market. Returns the headline status " +
				"(open/closed) from the Capital Market segment, plus per-segment detail. " +
				"`stale: true` means the upstream was unreachable and this is the last known value.",
			inputSchema: z.object({}),
		},
		async () => {
			try {
				const status = await getMarketStatus(cache);
				return { content: [{ type: "text" as const, text: JSON.stringify(status) }] };
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
} satisfies ExportedHandler<Env>;
