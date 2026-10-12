// Live end-to-end check against a deployed MCP endpoint. The full per-company sweep of every
// tool runs offline against a local copy of the site: see test/sweep.mjs.
// Usage: node test/smoke.mjs https://mcp.tickerscout.ai/mcp
//
// Tickers are chosen from the shapes that have broken renderers before:
// NVDA conventional, JPM bank_metrics, BRK-B nested insurance sections and the
// only hyphenated path, C the shortest ticker, WMT a retailer whose fiscal year
// runs far ahead of the calendar (FY27Q1 in mid-2026).
//
// WMT was once the one bundle with no headline block, and this file asserted that
// get_key_figures failed usefully for it. That bundle has since been regenerated
// and every covered company now carries a headline, so the assertion was passing
// judgement on a condition that no longer exists and started failing. The
// no-headline path is covered where it can still be exercised: see
// "condenseHeadline throws a useful error when there is no headline block" in
// test/financials.test.mjs. Do not re-add a live case for it without a real
// bundle that lacks one.
const ENDPOINT = process.argv[2] ?? "http://localhost:8787/mcp";
const TICKERS = ["NVDA", "JPM", "BRK-B", "C", "WMT"];

let id = 0;
let failures = 0;

async function call(method, params) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: ")) ?? text;
  return JSON.parse(line.replace(/^data: /, ""));
}

async function callTool(name, args) {
  const out = await call("tools/call", { name, arguments: args });
  const body = out.result?.content?.[0]?.text ?? JSON.stringify(out);
  return { isError: Boolean(out.result?.isError), body };
}

function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label} ${detail}`);
  }
}

console.log(`Smoke testing ${ENDPOINT}\n`);

const tools = await call("tools/list", {});
const names = (tools.result?.tools ?? []).map((t) => t.name);
const CORE = ["list_companies", "get_company", "get_key_figures", "get_financials", "get_narrative", "get_events"];
check("the main six tools are listed first", CORE.every((n, i) => names[i] === n), names.slice(0, 6).join(","));
check("the full tool set is listed", names.length === 20, String(names.length));

const list = await callTool("list_companies", {});
check("list_companies returns coverage", !list.isError && list.body.includes("coverage_count"));

const nvidia = await callTool("list_companies", { query: "nvidia" });
check("list_companies resolves a company name", nvidia.body.includes("NVDA"));

for (const t of TICKERS) {
  console.log(`\n${t}`);

  const company = await callTool("get_company", { ticker: t });
  check("get_company", !company.isError && company.body.includes("fiscal_period"));

  const fin = await callTool("get_financials", { ticker: t });
  check("get_financials full", !fin.isError && fin.body.includes('"units"'));

  const sections = fin.isError ? [] : (JSON.parse(fin.body).available_sections ?? []);
  check("available_sections is non-empty", sections.length > 0, JSON.stringify(sections));

  if (sections.length) {
    const slice = await callTool("get_financials", { ticker: t, sections: [sections[0]] });
    check("get_financials slice keeps meta.units", slice.body.includes('"units"'));
  }

  const keys = await callTool("get_key_figures", { ticker: t });
  check("get_key_figures", !keys.isError && keys.body.includes("metrics"));

  const narr = await callTool("get_narrative", { ticker: t });
  check("get_narrative returns an index", !narr.isError && narr.body.includes("sections"));

  const headings = narr.isError ? [] : (JSON.parse(narr.body).sections ?? []).map((s) => s.heading);
  check("narrative index is non-empty", headings.length > 0);

  if (headings.length) {
    const sec = await callTool("get_narrative", { ticker: t, section: headings[0] });
    check("get_narrative section fetch", !sec.isError && sec.body.includes("Source:"));
  }

  const ev = await callTool("get_events", { ticker: t });
  check("get_events returns full text", !ev.isError && ev.body.includes("Source:"));
}

console.log("\nArguments that replaced the 2.0 single-purpose tools");

const rev = await callTool("get_figure", { ticker: "NVDA", figure: "revenue" });
check("get_figure names the record's field", !rev.isError && rev.body.includes('"name_in_record"') && rev.body.includes("sec.gov"));
check("a generic name resolves the standard way", rev.body.includes('"matched_as": "standard figure"'));

const aapl = await callTool("get_figure", { ticker: "AAPL", figure: "revenue", period: "latest annual" });
check("AAPL revenue is reported as total_net_sales", aapl.body.includes('"total_net_sales"'));

const exact = await callTool("get_figure", { ticker: "AAPL", figure: "total_net_sales" });
check("get_figure answers a record name exactly", !exact.isError && exact.body.includes("exact name in the record"));

const several = await callTool("get_figure", { ticker: "MSFT", figure: ["revenue", "net income", "eps"] });
check("get_figure takes several figures in one call", !several.isError && (JSON.parse(several.body).results ?? []).length === 3);

const hist = await callTool("get_figure", { ticker: "NVDA", figure: "net income", period: "all" });
check("period='all' returns a history", !hist.isError && hist.body.includes('"history"') && hist.body.includes('"quarterly"'));

const periods = await callTool("list_periods", { ticker: "NVDA" });
check("list_periods returns fiscal years and quarters", !periods.isError && periods.body.includes('"quarters"'));

const old = await callTool("get_statements", { ticker: "NVDA", period: "FY2015" });
check("a period before the data says so", !old.isError && old.body.includes("going back that far"));

const older = await callTool("get_statements", { ticker: "NVDA", statement: "income_statement", period: "Q1 FY2027" });
check("a quarter only an older record holds is found", !older.isError && older.body.includes("Q1 FY2027"));

const ttm = await callTool("get_statements", { ticker: "AAPL", period: "ttm" });
check("get_statements returns the TTM block", !ttm.isError && ttm.body.includes("trailing_twelve_months"));

const seg = await callTool("get_segments", { ticker: "NVDA", breakdown: "revenue_by_product" });
check("get_segments returns a revenue breakdown", !seg.isError && seg.body.includes("Data Center"));

const bank = await callTool("get_company_metrics", { ticker: "JPM", kind: "bank" });
check("get_company_metrics returns bank metrics", !bank.isError && bank.body.includes("cet1"));

const fx = await callTool("get_reporting_conventions", { ticker: "TSM" });
check("get_reporting_conventions returns rates for a foreign issuer", !fx.isError && fx.body.includes("twd_per_usd"));

const acc = await callTool("get_filings", { ticker: "JPM" });
check("get_filings lists accessions", !acc.isError && acc.body.includes("edgar_index_url"));

const risk = await callTool("get_narrative", { ticker: "BRK-B", section: "risk factors" });
check("get_narrative finds a topic by name", !risk.isError && risk.body.includes("Risk"));

const earn = await callTool("get_events", { ticker: "NVDA", section: "earnings" });
check("get_events finds a topic by name", !earn.isError && earn.body.includes("Source:"));

const evIndex = await callTool("get_events", { ticker: "NVDA", index: true });
check("get_events index lists dated items", !evIndex.isError && evIndex.body.includes('"accessions"'));

const search = await callTool("search_text", { ticker: "NVDA", query: "export" });
check("search_text finds passages", !search.isError && search.body.includes('"passages"') && search.body.includes('"sections_ranked"'));

const cmp = await callTool("compare_companies", { tickers: ["NVDA", "JPM", "WMT"], figure: "net income" });
check("compare_companies returns a row per company", !cmp.isError && ["NVDA", "JPM", "WMT"].every((t) => cmp.body.includes(`"${t}"`)));

console.log("\nNegative cases");

const bad = await callTool("get_company", { ticker: "ZZZZ" });
check(
  "unknown ticker errors with suggestions",
  bad.isError && bad.body.includes("list_companies"),
  bad.body.slice(0, 120),
);

const badSection = await callTool("get_financials", { ticker: "NVDA", sections: ["nope"] });
check(
  "unknown section errors and lists valid ones",
  badSection.isError && badSection.body.includes("Available sections"),
);

const badNarrative = await callTool("get_narrative", {
  ticker: "NVDA",
  section: "cash flow statement",
});
check(
  "unknown narrative section errors",
  badNarrative.isError && badNarrative.body.includes("Available sections"),
);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}`);
process.exit(failures === 0 ? 0 : 1);
