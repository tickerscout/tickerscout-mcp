# Ticker Scout MCP server

An agent-native data layer for SEC filings, over the Model Context Protocol. Finished financial statements for public companies, and the filings themselves read and synthesized. The SEC publishes the numbers as data, but it does not publish them as statements. This serves them already assembled, through 20 tools: any statement for any fiscal year or quarter, any line item by its standard name or the company's own, every fiscal year and quarter held, every accession number cited, and the 10-K, 10-Q and 8-K narrative by section, topic or keyword. No API key, no signup, no paywall.

```
https://mcp.tickerscout.ai/mcp
```

It exposes the data published at tickerscout.ai ([https://tickerscout.ai](https://tickerscout.ai)): financial statements, the annual and quarterly reports read and synthesized, and material event histories for S&P 500 companies and major foreign issuers that file with the SEC, all derived from their own filings.

## What is already done for you

The difference between this and the EDGAR APIs is assembly, not availability. The SEC gives you facts. This gives you statements.

- **The three statements arrive as statements.** Income statement, balance sheet and cash flow, line items in reported order, not a flat bag of tagged facts you have to select concepts for and group yourself.
- **Assembled across filings, because no single filing holds the whole record.** Annual figures come from the annual report, quarterly and year-to-date figures from the quarterly report, and where a quarterly report presents cash flow only on a year-to-date basis, the discrete quarter comes from the earnings release filed as a current-report exhibit. For a US filer that means the 10-K, the 10-Q and the 8-K; for a foreign issuer, the 20-F or 40-F and the 6-K.
- **On the company's own fiscal calendar.** 52- and 53-week years, quarters that are 13-week periods rather than calendar quarters, and fiscal years that do not end in December. Period dates come from the column headings the filings themselves print.
- **In actual dollars and actual shares.** Never thousands, never millions, no scale factor to infer. Share counts are adjusted for splits. A foreign issuer's figures are converted to US dollars at the rate recorded on each period, and per-share figures are per ADS where the company has an ADR program.
- **Shaped to the business.** A bank, an insurer, an asset manager and a retailer do not have the same statements, so they do not get the same sections. Ask what a company has rather than assuming a fixed shape.
- **With the gaps named.** Where a filing does not disclose a figure it is omitted and the omission is explained, never silently zeroed. Every figure cites the SEC accession number it came from.
- **Figures link to the line of the filing that prints them.** Wherever the filing tags a figure, the response carries a sec.gov link that opens the filing at that number.

## Connect

**Claude Code**

```
claude mcp add --transport http ticker-scout https://mcp.tickerscout.ai/mcp
```

**Claude on the web or desktop**

Settings, then Connectors, then Add custom connector, and paste the URL.

**Cursor, and any client with an `mcpServers` config**

```json
{
  "mcpServers": {
    "ticker-scout": {
      "url": "https://mcp.tickerscout.ai/mcp"
    }
  }
}
```

**Clients that only speak stdio**

```json
{
  "mcpServers": {
    "ticker-scout": {
      "command": "npx",
      "args": ["mcp-remote", "https://mcp.tickerscout.ai/mcp"]
    }
  }
}
```

## Start here

The main six tools answer most questions in one call; the other fourteen each answer one kind of question, and take arguments rather than multiplying into near-duplicates.

| Question | Call |
| --- | --- |
| Is a company covered? What is its ticker? | `list_companies(query)` |
| How did it do last quarter? | `get_key_figures(ticker)` |
| Any line item, one or several at once | `get_figure(ticker, "revenue")`, `get_figure(ticker, ["revenue", "net income", "eps"])` |
| A figure's full history | `get_figure(ticker, "free cash flow", period: "all")` |
| A statement for one year, quarter, TTM or YTD | `get_statements(ticker, statement: "income_statement", period: "FY2025")` |
| How far back does the data go? | `list_periods(ticker)` |
| Segments, products, geography | `get_segments(ticker, breakdown?)` |
| KPIs, non-GAAP, bank or insurance metrics | `get_company_metrics(ticker, kind?)` |
| Margins | `get_margins_and_ratios(ticker)` |
| A company-specific metric | `list_company_figures(ticker, query: "data center")`, then `get_figure` |
| Compare companies | `compare_companies(["NVDA","AMD","AVGO"], "revenue")` |
| Risks, strategy, management's discussion | `get_narrative(ticker, section: "risk factors")` (or `business`, `md&a`, `current quarter`, `legal`, `subsequent events`) |
| What did the company announce? | `get_events(ticker)`, or `section: "earnings"`, `"m&a"`, `"management changes"`, ... |
| Find a topic anywhere in the filings | `search_text(ticker, query)` |
| Which filing did a number come from? | `get_figure` (a `sec_link` on every tagged value), `get_filings(ticker, accession?)` |
| Currency, ADR ratio, splits, fiscal calendar | `get_reporting_conventions(ticker)` |
| Not sure? | `guide()` |

Tickers are case-insensitive, and `BRK.B` and `BRK-B` both resolve.

## How the data is organized

### Records and periods

A **record** is the complete snapshot built when a company filed one 10-Q or 10-K, tagged by fiscal period: `FY27Q2` is the record built from NVIDIA's second-quarter fiscal 2027 10-Q, `FY26` one built from a 10-K. Each record holds several **periods**: up to three fiscal years, the latest quarter and its prior-year comparative, year to date and trailing twelve months. Older records hold older quarters, so a company's history is the union of its records, and every record stays published at a permanent dated URL.

Tools that take `period` search every record automatically. Tools that take `record` read one snapshot, the latest by default.

### The period argument

| You pass | You get |
| --- | --- |
| nothing | every period in the latest record |
| `FY2025`, `FY25`, `fiscal 2025`, `2025` | that fiscal year (the company's own fiscal year, not the calendar year) |
| `Q2 FY2027`, `Q2 2027`, `FY27Q2`, `2027Q2`, `2Q27`, `second quarter 2027` | that quarter |
| `Q2` | the latest second quarter held |
| `latest`, `latest quarter`, `latest annual` | the most recent period of that kind |
| `ttm`, `ytd`, `prior ytd` | trailing twelve months, year to date, the prior year's year to date |
| `annual`, `quarterly`, `all` | every fiscal year, every quarter, or every period in every record |
| `2026-07-26` | the period ending on that date |

A period earlier than anything held is not an error. The answer says the data does not go back that far and lists exactly what is held. A period not yet reported says so and gives the next expected filing.

### Names in the record

Records are shaped to each business, so the same line item has different names: Apple's revenue is `total_net_sales`, JPMorgan's is `total_net_revenue`, Walmart's net income is `net_income_attributable_to_walmart`. Nothing is relabeled to hide that.

- Every value a figure tool returns leads with `name_in_record` (the record's own name), `field` (its path inside the period) and `json_path` (its exact address in `financials.json`, e.g. `annual[0].income_statement.total_net_sales`).
- Any of those names can be passed back to `get_figure` exactly as written, and returns exactly that field. Case, spaces and underscores do not matter: `Data Center` and `revenue_by_market_platform.Data Center` both work.
- A standard figure asked for by its generic words (`revenue`, `net income`, `free cash flow`) resolves the standard way below, each value still under the record's own name. If the record also has other fields of that name (NVIDIA's segment tables each carry a `revenue`), they are listed under `other_fields_with_this_name`, callable by path.
- `list_company_figures` maps each standard figure to the name this company uses, then lists every remaining figure under its own name. Pass `query` to search those names.

### Standard figures

`get_figure` and `compare_companies` know the names each figure goes by across companies and resolve deterministically: first the field the company's own headline uses for it, then a list of known names in order, then a name pattern only when exactly one field matches. Nothing is estimated, derived or summed to fill a gap. Look-alike fields in the same statement come back under `related`, and a company that reports none of the names gets a plain "not reported" with the closest fields it does have.

| Figure | Ask for it as | Read from, for example |
| --- | --- | --- |
| Revenue | `revenue`, `sales` | `revenue`, `revenues`, `total_revenues`, `total_revenue`, +19 more |
| Cost of revenue | `cost of revenue`, `cogs` | `cost_of_revenue`, `cost_of_sales`, `total_cost_of_revenue`, `cost_of_goods_sold`, +10 more |
| Gross profit, gross margin % | `gross profit`, `gross margin` | `gross_profit`, `gross_margin`, `gross_margin_pct`, +3 more |
| Research and development | `r&d` | `research_and_development`, `research_and_development_expenses`, +7 more |
| Selling, general and administrative | `sga` | `selling_general_and_administrative`, `sales_general_and_administrative`, +7 more |
| Total operating expenses | `operating expenses`, `opex` | `total_operating_expenses`, `total_costs_and_expenses`, `total_noninterest_expense`, +11 more |
| Operating income | `operating income`, `ebit` | `operating_income`, `income_from_operations`, `operating_profit`, +4 more |
| Interest expense | `interest expense` | `interest_expense`, `total_interest_expense`, `interest_expense_net`, `interest_and_debt_expense` |
| Income before income taxes | `pretax income` | `income_before_income_taxes`, `earnings_before_income_taxes`, +23 more |
| Income tax, effective tax rate | `income tax`, `effective tax rate` | `provision_for_income_taxes`, `income_tax_expense`, `effective_tax_rate_pct`, +17 more |
| Net income | `net income`, `earnings` | `net_income`, `net_earnings`, `net_income_attributable_to_<company>`, +8 more |
| Diluted and basic EPS | `eps`, `basic eps` | `diluted_eps`, `eps_diluted`, `basic_eps`, +11 more |
| Diluted, basic and outstanding shares | `diluted shares`, `basic shares`, `shares outstanding` | `diluted_shares`, `basic_shares`, `shares_outstanding`, +27 more |
| Depreciation and amortization | `d&a` | `depreciation_and_amortization`, `depreciation_depletion_and_amortization`, +7 more |
| Stock-based compensation | `sbc` | `stock_based_compensation`, `share_based_compensation`, +4 more |
| Net interest income, noninterest income (banks) | `net interest income`, `noninterest income` | `net_interest_income`, `total_noninterest_income`, +7 more |
| Provision for credit losses (banks) | `provision for credit losses` | `provision_for_credit_losses`, `provision_for_loan_losses`, +4 more |
| Cash and cash equivalents | `cash` | `cash_and_cash_equivalents`, `cash_and_equivalents`, `cash_and_due_from_banks`, +5 more |
| Total assets | `total assets` | `total_assets`, `assets.total_assets` |
| Total liabilities | `total liabilities` | `total_liabilities`, `liabilities.total_liabilities` |
| Total, long-term and short-term debt | `debt`, `long-term debt`, `short-term debt` | `total_debt`, `long_term_debt`, `short_term_debt`, `current_portion_of_long_term_debt`, +32 more |
| Shareholders' equity | `equity`, `book value` | `total_stockholders_equity`, `total_shareholders_equity`, `total_<company>_shareholders_equity`, `total_equity`, +7 more |
| Current assets and liabilities, working capital | `current assets`, `current liabilities` (working capital: `get_margins_and_ratios`) | `total_current_assets`, `total_current_liabilities` |
| Goodwill and intangibles | `goodwill`, `intangibles` | `goodwill`, `intangible_assets_net`, `other_intangible_assets_net`, +11 more |
| Inventories | `inventory` | `inventories`, `inventory`, `merchandise_inventories`, +4 more |
| Accounts receivable | `receivables` | `accounts_receivable_net`, `receivables_net`, `trade_receivables_net`, +7 more |
| Accounts payable | `payables` | `accounts_payable`, `trade_accounts_payable`, `trade_payables`, +3 more |
| Property, plant and equipment | `pp&e` | `property_plant_and_equipment_net`, `property_and_equipment_net`, +7 more |
| Retained earnings | `retained earnings` | `retained_earnings`, `accumulated_deficit`, +3 more |
| Operating cash flow | `operating cash flow`, `cfo` | `operating_cash_flow`, `net_cash_provided_by_operating_activities`, +10 more |
| Capital expenditures | `capex` | `capex`, `capital_expenditures`, `purchases_of_property_and_equipment`, +10 more |
| Free cash flow | `free cash flow`, `fcf` | `free_cash_flow`, `free_cash_flow_for_the_quarter`, +2 more |
| Investing and financing cash flow | `investing cash flow`, `financing cash flow` | `investing_cash_flow`, `financing_cash_flow`, `net_cash_used_in_investing_activities`, +21 more |
| Dividends paid, dividends per share | `dividends`, `dividends per share` | `dividends_paid`, `cash_dividends_paid`, `dividends_per_share`, `dividends_declared_per_share`, +14 more |
| Share repurchases | `buybacks` | `share_repurchases`, `repurchases_of_common_stock`, `purchases_of_treasury_stock`, +11 more |
| Acquisitions, net of cash acquired | `acquisitions` | `acquisitions_net_of_cash_acquired`, +7 more |

`guide()` returns the full catalog with every word each figure answers to.

### Units and sources

All money is in actual dollars (not thousands, not millions), per-share figures in dollars per share, share counts in actual shares, split-adjusted. Every figure response carries the record's own units statement, so a value is never separated from its scale.

Every value carries the SEC accession number of the filing it came from and, where the filing tags the number, a `sec_link` that opens the filing at the line printing it. A value with no link was calculated in the record (margins, free cash flow, trailing twelve months, a quarter derived by subtraction) or comes from an earnings release, which the SEC does not tag. Margins and ratios this server calculates (`get_margins_and_ratios`) are labeled `calculated` and show their formula and the exact fields used.

## All 20 tools

Every tool is read-only. Tickers are case-insensitive. A `period` argument takes the syntax above and searches every record; a `record` argument reads one earlier snapshot.

### The main six

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_companies` | `query?` | Every covered company with its latest fiscal period, every record held and its next expected filing, plus a coverage summary. Resolves a company name to a ticker. |
| `get_company` | `ticker`, `record?` | Identity and coverage manifest: name, CIK, exchange, state of incorporation, SIC industry, the filings the record is built from with accessions and EDGAR links, every published record, the predicted next filing, and a map of every tool. |
| `get_key_figures` | `ticker`, `record?` | Headline figures for the latest period, each with its year-over-year change, exact amount, record field and source accession, plus the written summary and Q&A. |
| `get_financials` | `ticker`, `sections?`, `record?` | The whole financial record, sliceable by top-level section. `figure_sources` (the sec.gov link for every tagged figure) only on request. |
| `get_narrative` | `ticker`, `section?`, `record?` | The 10-K and 10-Q synthesis. An index of sections and subsections by default; any section or subsection by heading, a topic (`business`, `risk factors`, `md&a`, `current quarter`, `subsequent events`, `legal`), or `all`. |
| `get_events` | `ticker`, `section?`, `index?`, `record?` | The 8-K digest over roughly the trailing five quarters: in full, one section or topic (`earnings`, `management changes`, `capital returns`, `debt and financing`, `m&a`, `governance`, `restructuring`, `legal`), or a dated one-line index. |

### Statements and periods

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_periods` | `ticker` | Every fiscal year and quarter held across every record, with dates, length, source form and accession, the fiscal year end and 52/53-week detection, and every record with its permanent URLs. |
| `get_statements` | `ticker`, `statement?`, `period?`, `include_sources?` | The income statement, balance sheet or cash flow (or everything held) for any period, including `ttm` and `ytd`, searching older records; plain "not that far back" or "not reported yet" answers outside the range. |
| `get_segments` | `ticker`, `breakdown?`, `period?` | Segment results, revenue by product, service or end market, and revenue by geography, as the company reports them. |
| `get_company_metrics` | `ticker`, `kind?`, `period?` | Operating KPIs, non-GAAP measures, bank metrics (CET1, net interest margin, efficiency ratio) and insurance metrics (premiums, combined ratio, float), in the company's own definitions. |
| `get_margins_and_ratios` | `ticker`, `period?` | Every margin and rate the record stores, plus gross, operating, net and FCF margin, working capital and current ratio, calculated and labeled with their formulas. |

### Figures

| Tool | Arguments | Returns |
| --- | --- | --- |
| `get_figure` | `ticker`, `figure` (one or up to ten), `period?` | Any figure by standard name, record name, path or words, for every period, one period, or the full history (`period: "all"`). Every value with its record name, JSON path, dates, accession and sec.gov link. |
| `list_company_figures` | `ticker`, `query?`, `block?`, `period?` | Each standard figure mapped to this company's name for it, then every remaining figure under its own name, with values; or, with `query`, the fields whose names contain the words. |
| `compare_companies` | `tickers`, `figure`, `period?` | One standard figure for two to ten companies, each row with its own period, dates and record name. |

### Search, filings and conventions

| Tool | Arguments | Returns |
| --- | --- | --- |
| `search_text` | `ticker`, `query`, `documents?`, `limit?`, `record?` | The paragraphs and list items in the narrative, events and record notes that contain every word, in full, plus the sections that mention it most. Quote a phrase to match it exactly. |
| `get_filings` | `ticker`, `accession?`, `record?` | Every accession cited across statements, narrative and events, with form, filing date, EDGAR links and every use; or one filing in full, with every passage that cites it. |
| `get_reporting_conventions` | `ticker`, `record?` | Units, reporting currency and each period's exchange rate for a foreign issuer, ADR ratio, splits adjusted for, fiscal year end, accounting basis and the record's own definitions. |
| `get_data_notes` | `ticker`, `record?` | The record's sourcing notes, its uncertainties, and which standard figures the latest periods lack. |
| `list_upcoming_filings` | `days?`, `form?` | Every covered company expected to file within N days, soonest first. |
| `guide` | none | How the tools fit together, the period syntax, units, citations, common questions and the standard figure catalog. |

## Examples

```
> What did NVIDIA earn last quarter?

  get_key_figures(ticker: "NVDA")
```

```
> Apple's revenue for fiscal 2025, and where the 10-K prints it

  get_figure(ticker: "AAPL", figure: "revenue", period: "FY2025")

  name_in_record  total_net_sales
  json_path       annual[0].income_statement.total_net_sales
  value           416161000000   ($416.16 billion)
  accession       0000320193-25-000079
  sec_link        https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250927.htm#f-78
```

```
> NVIDIA revenue in fiscal 2019

  get_figure(ticker: "NVDA", figure: "revenue", period: "FY2019")

  available: false
  We don't have data going back that far: FY2019 is earlier than anything Ticker Scout
  holds for NVDA. The earliest fiscal year held is FY2024. ...
```

```
> Microsoft's revenue, net income and EPS in one call

  get_figure(ticker: "MSFT", figure: ["revenue", "net income", "eps"], period: "latest quarter")
```

```
> NVIDIA Data Center revenue, every quarter held

  get_figure(ticker: "NVDA", figure: "Data Center", period: "all")
```

## Data policy

- Everything is derived from public reports filed with the SEC, such as annual reports on Form 10-K, quarterly reports on Form 10-Q and current reports on Form 8-K (20-F, 40-F and 6-K for foreign issuers). Nothing is estimated and nothing is fabricated. Where a filing does not disclose a figure, it is omitted and the omission is explained.
- No market price data. No quotes, no market caps, no price snapshots. This is a fundamentals source.
- Data is refreshed each quarter, shortly after a company files. Coverage and the period held for each company are in `list_companies`.
- This is factual synthesis of public filings. It is not investment advice.

Free to read and cite. Please attribute "Ticker Scout (tickerscout.ai)".

## How it works

A stateless Cloudflare Worker using `createMcpHandler` from `@modelcontextprotocol/server`, speaking streamable HTTP at `/mcp`.

The server stores no data. Every tool call fetches the corresponding files from `https://tickerscout.ai` through the Cloudflare edge cache and shapes the response; a question about an older period reads that record's permanent dated URL. There is no database, no snapshot and no fallback copy: if an upstream file cannot be fetched, the tool returns an error naming the URL and the status rather than serving something stale.

```
src/
  index.ts       Worker entrypoint (exports the handler only)
  server.ts      Builds the tool definitions once per isolate, a server per request
  upstream.ts    Fetching, edge caching, the error policy
  tickers.ts     Ticker normalization, coverage search, near matches
  records.ts     A company's published records, and choosing which to read
  periods.ts     Fiscal periods: naming, the period syntax, out-of-range answers
  figures.ts     Standard figures, name resolution, figure_sources links
  filings.ts     Accession numbers, EDGAR links, citations in prose
  topics.ts      Narrative and events topics, keyword search
  markdown.ts    Section parsing for the .md documents
  financials.ts  Headline condensing and unit-safe slicing
  respond.ts     Result shaping, source URL and attribution
  tools/         Tool registration, one module per group
```

## Development

```
npm install
npm test                      # unit tests for the pure modules
npm run type-check            # wrangler deploy does not typecheck
npm run dev                   # local server on http://localhost:8787/mcp
npm run smoke -- <url>        # live end-to-end check against a deployment
npm run sweep -- <site dir>   # every tool, every company, against a local copy of the site
npm run deploy
```

`npm test` covers the pure logic. `test/smoke.mjs` calls the tools against a running server for a deliberately shape-diverse set of companies (a conventional company, a bank, an insurance conglomerate, a retailer far ahead of the calendar, a foreign issuer) plus negative cases. `test/sweep.mjs` runs every tool for every covered company in-process, plus every topic, statement, breakdown and metric kind, serving the site's files from a local directory, and fails on any error. A unit test keeps `tools/list` under 40 KB.

## License

MIT. See [LICENSE](LICENSE).
