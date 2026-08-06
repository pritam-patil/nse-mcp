import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { getMarketStatus, isDataError } from "./data";

/** Render a thrown DataError as a tool error the model can reason about. */
function toolError(err: unknown) {
	const code = isDataError(err) ? err.code : "SOURCE_UNAVAILABLE";
	const message = err instanceof Error ? err.message : String(err);
	return {
		isError: true,
		content: [{ type: "text" as const, text: JSON.stringify({ error: code, message }) }],
	};
}

function createServer() {
	const server = new McpServer({
		name: "nse-data",
		version: "1.0.0",
	});

	server.registerTool(
		"get_market_status",
		{
			description:
				"Get the current trading status of the NSE market. Returns the headline status " +
				"(open/closed) from the Capital Market segment, plus per-segment detail.",
			inputSchema: z.object({}),
		},
		async () => {
			try {
				const status = await getMarketStatus();
				return { content: [{ type: "text" as const, text: JSON.stringify(status) }] };
			} catch (err) {
				return toolError(err);
			}
		},
	);

	return server;
}

const handler = createMcpHandler(createServer);

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return handler(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
