import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { handleSpike } from "./spike";

function createServer() {
	const server = new McpServer({
		name: "nse-data",
		version: "1.0.0",
	});

	server.registerTool(
		"get_market_status",
		{
			description: "Get the current status of the NSE market",
			inputSchema: z.object({}),
		},
		async () => ({
			content: [
				{
					type: "text",
					text: JSON.stringify({ market: "NSE", status: "unknown" }),
				},
			],
		}),
	);

	return server;
}

const handler = createMcpHandler(createServer);

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		// TEMPORARY (Burse 2): upstream source probe. Remove with src/spike.ts.
		if (new URL(request.url).pathname === "/spike") {
			return handleSpike(request);
		}
		return handler(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
