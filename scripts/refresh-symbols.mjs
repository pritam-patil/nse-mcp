#!/usr/bin/env node
/**
 * Manually refresh the NSE equity symbol list in KV under `v1:symbols`.
 *
 * The Worker also does this weekly via cron (see wrangler.jsonc); this script
 * is for the initial seed and for on-demand refreshes. It fetches EQUITY_L.csv,
 * parses it, and writes the same JSON envelope the Worker expects, via
 * `wrangler kv key put`.
 *
 * Usage:
 *   node scripts/refresh-symbols.mjs            # write to remote (production) KV
 *   node scripts/refresh-symbols.mjs --local    # write to local dev KV
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EQUITY_L_URL = "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv";
const KEY = "v1:symbols";
const BROWSER_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const local = process.argv.includes("--local");

/** Mirror of src/data/symbols.ts splitCsvLine — kept trivially in sync. */
function splitCsvLine(line) {
	const out = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quoted) {
			if (ch === '"') {
				if (line[i + 1] === '"') {
					field += '"';
					i++;
				} else quoted = false;
			} else field += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === ",") {
			out.push(field);
			field = "";
		} else field += ch;
	}
	out.push(field);
	return out;
}

function parseEquityCsv(csv) {
	const lines = csv.split(/\r?\n/);
	const symbols = [];
	for (let i = 1; i < lines.length; i++) {
		if (!lines[i].trim()) continue;
		const cols = splitCsvLine(lines[i]);
		const symbol = (cols[0] ?? "").trim();
		const name = (cols[1] ?? "").trim();
		if (symbol && name) symbols.push([symbol, name]);
	}
	return symbols;
}

async function main() {
	console.log(`Fetching ${EQUITY_L_URL} ...`);
	const res = await fetch(EQUITY_L_URL, { headers: { "User-Agent": BROWSER_UA } });
	if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
	const csv = await res.text();

	const symbols = parseEquityCsv(csv);
	console.log(`Parsed ${symbols.length} symbols.`);
	if (symbols.length < 100) throw new Error(`implausibly few rows (${symbols.length}); aborting`);

	const payload = JSON.stringify({
		v: 1,
		storedAt: new Date().toISOString(),
		count: symbols.length,
		symbols,
	});

	const file = join(mkdtempSync(join(tmpdir(), "nse-symbols-")), "symbols.json");
	writeFileSync(file, payload);

	const args = ["kv", "key", "put", KEY, `--path=${file}`, "--binding=CACHE"];
	args.push(local ? "--local" : "--remote");
	console.log(`Writing to ${local ? "local" : "remote"} KV: ${KEY} ...`);
	execFileSync("npx", ["wrangler", ...args], { stdio: "inherit" });
	console.log("Done.");
}

main().catch((err) => {
	console.error(err.message ?? err);
	process.exit(1);
});
