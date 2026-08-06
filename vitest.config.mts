import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Mappers are pure functions over JSON, so plain Node is enough — no
		// Workers pool needed. Anything that touches `fetch` stubs it.
		environment: "node",
		include: ["test/**/*.spec.ts"],
	},
});
