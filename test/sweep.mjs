// Every tool, for every covered company, run in-process against a local copy of the site.
// Usage: node test/sweep.mjs <path to a local copy of tickerscout.ai> [TICKER,TICKER...]
//
// The real MCP handler answers each call; only fetches of https://tickerscout.ai/* are served
// from the directory given, so a full sweep (about 6,000 calls) never touches the live site.
// It fails on any tool error. A "not available" answer is not an error: it is how a tool says
// a company does not report something, and the counts are printed so a change in them shows.
import fs from "node:fs";
import path from "node:path";

const SITE = process.argv[2];
if (!SITE || !fs.existsSync(path.join(SITE, "tickers.json"))) {
  console.error("Usage: node test/sweep.mjs <local site directory containing tickers.json> [TICKERS]");
  process.exit(2);
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("https://tickerscout.ai/")) {
    const p = path.join(SITE, decodeURIComponent(new URL(url).pathname));
    if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) return new Response("not found", { status: 404 });
    return new Response(fs.readFileSync(p));
  }
  return realFetch(input, init);
};

const { createMcpHandler } = await import("@modelcontextprotocol/server");
const { createServer } = await import("../src/server.ts");
const handler = createMcpHandler(createServer);

let id = 0;
async function call(method, params) {
  const req = new Request("http://local/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const res = await handler.fetch(req, {}, { waitUntil() {}, passThroughOnException() {} });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: ")) ?? text;
  return JSON.parse(line.replace(/^data: /, ""));
}

const all = JSON.parse(fs.readFileSync(path.join(SITE, "tickers.json"), "utf8")).tickers.map((t) => t.ticker);
const tickers = process.argv[3] ? process.argv[3].split(",") : all;
const tools = (await call("tools/list", {})).result.tools;

let calls = 0;
const errors = [];
const unavailable = {};
for (const t of tools) {
  const props = t.inputSchema.properties ?? {};
  const runs = props.ticker ? tickers.map((ticker) => ({ ticker })) : props.tickers ? [{ tickers: tickers.slice(0, 10) }] : [{}];
  for (const args of runs) {
    if (props.query && t.inputSchema.required?.includes("query")) args.query = "revenue";
    if (props.figure) args.figure = "revenue";
    if (props.period && t.inputSchema.required?.includes("period")) args.period = "latest";
    await run(t.name, args);
  }
}

// The arguments that used to be separate tools before 3.0: every topic, every statement and
// breakdown, the events index, several figures at once and a figure's full history.
const VARIANTS = [
  ...["business", "risk factors", "md&a", "current quarter", "subsequent events", "legal"].map((section) => ["get_narrative", { section }]),
  ...["earnings", "management changes", "capital returns", "debt and financing", "m&a", "governance", "restructuring", "legal"].map((section) => ["get_events", { section }]),
  ["get_events", { index: true }],
  ...["income_statement", "balance_sheet", "cash_flow"].map((statement) => ["get_statements", { statement, period: "latest" }]),
  ["get_statements", { period: "ttm" }],
  ...["segments", "revenue_by_product", "revenue_by_geography"].map((breakdown) => ["get_segments", { breakdown }]),
  ...["operating", "non_gaap", "bank", "insurance"].map((kind) => ["get_company_metrics", { kind }]),
  ["get_figure", { figure: ["revenue", "net income", "eps", "free cash flow", "total debt"] }],
  ["get_figure", { figure: "net income", period: "all" }],
  ["list_company_figures", { query: "income" }],
];
for (const ticker of tickers) {
  for (const [name, extra] of VARIANTS) await run(name, { ticker, ...extra });
  // One filing by accession: the first one the list mode returns.
  const list = await call("tools/call", { name: "get_filings", arguments: { ticker } });
  const first = JSON.parse(list.result?.content?.[0]?.text ?? "{}").accessions?.[0]?.accession;
  if (first) await run("get_filings", { ticker, accession: first });
}

async function run(name, args) {
  const out = await call("tools/call", { name, arguments: args });
  calls++;
  // Yield between calls as separate Worker requests would. Without this, one long chain of
  // awaits keeps every request's AbortSignal (and the server its listener holds) alive until
  // the chain ends, which looks like a leak and is only the harness.
  await new Promise((r) => setTimeout(r, 0));
  const text = out.result?.content?.[0]?.text ?? JSON.stringify(out.error ?? out);
  const label = `${name}${args.section ? `(${args.section})` : args.statement ? `(${args.statement})` : args.breakdown ? `(${args.breakdown})` : args.kind ? `(${args.kind})` : ""}`;
  if (out.result?.isError || out.error) errors.push(`${name} ${JSON.stringify(args)}: ${text.slice(0, 240)}`);
  else if (text.includes('"available": false')) unavailable[label] = (unavailable[label] ?? 0) + 1;
}

console.log(`${tools.length} tools, ${calls} calls over ${tickers.length} companies, ${errors.length} errors`);
for (const e of errors.slice(0, 80)) console.log(`  ERROR ${e}`);
console.log(`"not available" answers by tool: ${JSON.stringify(unavailable)}`);
process.exit(errors.length ? 1 : 0);
