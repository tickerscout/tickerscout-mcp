# Ticker Scout MCP server

An agent-native data layer for SEC filings, over the Model Context Protocol. Finished financial statements for public companies, and the filings themselves read and synthesized. The SEC publishes the numbers as data, but it does not publish them as statements. This serves them already assembled, through 97 tools: every statement, every standard line item, every company-specific figure under the name its record uses, every fiscal year and quarter held, every accession number cited, and the 10-K, 10-Q and 8-K narrative by section or by keyword. No API key, no signup, no paywall.

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

The six original tools still answer most questions in one call, and work exactly as they did in 1.x. The other 91 go straight to one thing.

| Question | Call |
| --- | --- |
| Is a company covered? What is its ticker? | `list_companies(query)` |
| How much did it earn last quarter? | `get_key_figures(ticker)` |
| Revenue (or any line item) across every period held | `get_revenue(ticker)`, `get_net_income(ticker)`, ... |
| One specific year or quarter | `get_period(ticker, "FY2025")`, or any figure tool with `period` |
| How far back does the data go? | `list_periods(ticker)` |
| Every figure this company reports, by its own names | `list_company_figures(ticker)` |
| A company-specific metric | `find_figures(ticker, "data center")`, then `get_figure` |
| Compare companies | `compare_companies(["NVDA","AMD","AVGO"], "revenue")` |
| Segments, products, geography | `get_segments`, `get_revenue_breakdown`, `get_geographic_revenue` |
| Risks, strategy, management's discussion | `get_risk_factors`, `get_business_overview`, `get_annual_mdna`, `get_current_quarter` |
| What did the company announce? | `list_events`, `get_earnings_releases`, `get_management_changes`, ... |
| Find a topic anywhere in the filings | `search_sections(ticker, query)`, `search_text(ticker, query)` |
| Which filing did a number come from? | `get_figure_source`, `get_accession_numbers`, `get_filing` |
| Currency, ADR ratio, fiscal calendar, splits | `get_currency_conversion`, `get_adr_details`, `get_fiscal_calendar`, `get_stock_splits` |
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
- Any of those names can be passed back to `get_figure` or `get_figure_history` exactly as written, and returns exactly that field. Case, spaces and underscores do not matter: `Data Center` and `revenue_by_market_platform.Data Center` both work.
- `list_company_figures` maps each standard figure to the name this company uses, then lists every remaining figure under its own name.

### Standard figures

Each line-item tool knows the names a figure goes by across companies and resolves deterministically: first the field the company's own headline uses for it, then a list of known names in order, then a name pattern only when exactly one field matches. Nothing is estimated, derived or summed to fill a gap. Look-alike fields in the same statement come back under `related`, and a company that reports none of the names gets a plain "not reported" with the closest fields it does have.

| Figure | Tool | Read from, for example |
| --- | --- | --- |
| Revenue | `get_revenue` | `revenue`, `revenues`, `total_revenues`, `total_revenue`, +19 more |
| Cost of revenue | `get_cost_of_revenue` | `cost_of_revenue`, `cost_of_sales`, `total_cost_of_revenue`, `cost_of_goods_sold`, +10 more |
| Gross profit, gross margin % | `get_gross_profit` | `gross_profit`, `gross_margin`, `gross_margin_pct`, +3 more |
| Research and development | `get_research_and_development` | `research_and_development`, `research_and_development_expenses`, +7 more |
| Selling, general and administrative | `get_sga_expense` | `selling_general_and_administrative`, `sales_general_and_administrative`, +7 more |
| Total operating expenses | `get_operating_expenses` | `total_operating_expenses`, `total_costs_and_expenses`, `total_noninterest_expense`, +11 more |
| Operating income | `get_operating_income` | `operating_income`, `income_from_operations`, `operating_profit`, +4 more |
| Interest expense | `get_interest_expense` | `interest_expense`, `total_interest_expense`, `interest_expense_net`, `interest_and_debt_expense` |
| Income before income taxes | `get_pretax_income` | `income_before_income_taxes`, `earnings_before_income_taxes`, +23 more |
| Income tax, effective tax rate | `get_income_tax` | `provision_for_income_taxes`, `income_tax_expense`, `effective_tax_rate_pct`, +17 more |
| Net income | `get_net_income` | `net_income`, `net_earnings`, `net_income_attributable_to_<company>`, +8 more |
| Diluted and basic EPS | `get_eps` | `diluted_eps`, `eps_diluted`, `basic_eps`, +11 more |
| Diluted, basic and outstanding shares | `get_share_count` | `diluted_shares`, `basic_shares`, `shares_outstanding`, +27 more |
| Depreciation and amortization | `get_depreciation_and_amortization` | `depreciation_and_amortization`, `depreciation_depletion_and_amortization`, +7 more |
| Stock-based compensation | `get_stock_based_compensation` | `stock_based_compensation`, `share_based_compensation`, +4 more |
| Net interest income, noninterest income (banks) | `get_net_interest_income` | `net_interest_income`, `total_noninterest_income`, +7 more |
| Provision for credit losses (banks) | `get_credit_loss_provision` | `provision_for_credit_losses`, `provision_for_loan_losses`, +4 more |
| Cash and cash equivalents | `get_cash` | `cash_and_cash_equivalents`, `cash_and_equivalents`, `cash_and_due_from_banks`, +5 more |
| Total assets | `get_total_assets` | `total_assets`, `assets.total_assets` |
| Total liabilities | `get_total_liabilities` | `total_liabilities`, `liabilities.total_liabilities` |
| Total, long-term and short-term debt | `get_debt` | `total_debt`, `long_term_debt`, `short_term_debt`, `current_portion_of_long_term_debt`, +32 more |
| Shareholders' equity | `get_shareholders_equity` | `total_stockholders_equity`, `total_shareholders_equity`, `total_<company>_shareholders_equity`, `total_equity`, +7 more |
| Current assets and liabilities, working capital | `get_working_capital` | `total_current_assets`, `total_current_liabilities` |
| Goodwill and intangibles | `get_goodwill_and_intangibles` | `goodwill`, `intangible_assets_net`, `other_intangible_assets_net`, +11 more |
| Inventories | `get_inventories` | `inventories`, `inventory`, `merchandise_inventories`, +4 more |
| Accounts receivable | `get_accounts_receivable` | `accounts_receivable_net`, `receivables_net`, `trade_receivables_net`, +7 more |
| Accounts payable | `get_accounts_payable` | `accounts_payable`, `trade_accounts_payable`, `trade_payables`, +3 more |
| Property, plant and equipment | `get_property_and_equipment` | `property_plant_and_equipment_net`, `property_and_equipment_net`, +7 more |
| Retained earnings | `get_retained_earnings` | `retained_earnings`, `accumulated_deficit`, +3 more |
| Operating cash flow | `get_operating_cash_flow` | `operating_cash_flow`, `net_cash_provided_by_operating_activities`, +10 more |
| Capital expenditures | `get_capital_expenditures` | `capex`, `capital_expenditures`, `purchases_of_property_and_equipment`, +10 more |
| Free cash flow | `get_free_cash_flow` | `free_cash_flow`, `free_cash_flow_for_the_quarter`, +2 more |
| Investing and financing cash flow | `get_investing_and_financing_cash_flow` | `investing_cash_flow`, `financing_cash_flow`, `net_cash_used_in_investing_activities`, +21 more |
| Dividends paid, dividends per share | `get_dividends` | `dividends_paid`, `cash_dividends_paid`, `dividends_per_share`, `dividends_declared_per_share`, +14 more |
| Share repurchases | `get_share_repurchases` | `share_repurchases`, `repurchases_of_common_stock`, `purchases_of_treasury_stock`, +11 more |
| Acquisitions, net of cash acquired | `get_acquisitions` | `acquisitions_net_of_cash_acquired`, +7 more |

`list_standard_figures` returns the full catalog with every name each figure is read from.

### Units and sources

All money is in actual dollars (not thousands, not millions), per-share figures in dollars per share, share counts in actual shares, split-adjusted. Every figure response carries the record's own units statement, so a value is never separated from its scale.

Every value carries the SEC accession number of the filing it came from and, where the filing tags the number, a `sec_link` that opens the filing at the line printing it. A value with no link was calculated in the record (margins, free cash flow, trailing twelve months, a quarter derived by subtraction) or comes from an earnings release, which the SEC does not tag. Margins this server calculates (`get_margins`, `get_working_capital`) are labeled `calculated` and show their formula and the exact fields used.

## All 97 tools

### Original tools (unchanged; `record` added)

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_companies` | `query?` | Every covered company with its latest fiscal period, every record held, and its next expected filing. Resolves a company name to a ticker. |
| `get_company` | `ticker`, `record?` | Identity and coverage manifest: name, CIK, exchange, state of incorporation, SIC industry, the filings the record is built from with accessions and EDGAR links, every published record, the next filing, and a map of every tool. |
| `get_key_figures` | `ticker`, `record?` | Headline figures for the latest period, each with its year-over-year change, exact amount and source accession. |
| `get_financials` | `ticker`, `sections?`, `record?` | The whole financial record, sliceable by top-level section. `figure_sources` (the sec.gov link for every tagged figure) only on request. |
| `get_narrative` | `ticker`, `section?`, `record?` | The 10-K and 10-Q synthesis. A section index by default; any section by name, or `all`. |
| `get_events` | `ticker`, `section?`, `record?` | The 8-K digest over roughly the trailing five quarters, in full or one section. |

### Periods and history

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_periods` | `ticker` | Every fiscal year and quarter held across every record, with dates, length, source form and accession, which records carry each, and the list of records with their permanent URLs. |
| `get_period` | `ticker`, `period`, `include_sources?` | Every statement and table held for one fiscal year or quarter, searching older records; plain "not that far back" or "not reported yet" answers outside the range. |
| `get_trailing_twelve_months` | `ticker`, `record?` | The TTM income statement and cash flow with the derivation note saying how it was built. |
| `get_year_to_date` | `ticker`, `record?` | The year-to-date block and the prior year's year-to-date comparative. |
| `get_figure_history` | `ticker`, `figure` | One figure across every period held, oldest first, annual and quarterly series, with the record each value came from. |

### Statements and tables

| Tool | Arguments | Returns |
| --- | --- | --- |
| `get_income_statement` | `ticker`, `period?` | The income statement in reported order, with per-share blocks. |
| `get_balance_sheet` | `ticker`, `period?` | The balance sheet at each period end. |
| `get_cash_flow_statement` | `ticker`, `period?` | The cash flow statement, with free cash flow. |
| `get_segments` | `ticker`, `period?` | Results by reportable segment as the company reports them. |
| `get_revenue_breakdown` | `ticker`, `period?` | Revenue by product, service, end market, platform, channel or category. |
| `get_geographic_revenue` | `ticker`, `period?` | Revenue (and assets or income where reported) by country or region. |
| `get_non_gaap_measures` | `ticker`, `period?` | Adjusted EPS, adjusted operating income, EBITDA, FFO and other company-defined measures. |
| `get_operating_metrics` | `ticker`, `period?` | KPIs outside the statements: users, subscribers, bookings, stores, RevPAR, backlog and the like. |
| `get_bank_metrics` | `ticker`, `period?` | CET1 and capital ratios, net interest margin, efficiency ratio, average balances, credit quality. |
| `get_insurance_metrics` | `ticker`, `period?` | Premiums, underwriting results, combined ratios, investment income, float, book value. |
| `get_margins` | `ticker`, `period?` | Every margin and rate the record stores, plus gross, operating, net and FCF margin calculated and labeled. |

### One line item, every period

Each takes `ticker` and `period?` and returns the figure for every period (or the one named), each value with its record name, JSON path, dates, accession, form and sec.gov link.

`get_revenue`, `get_cost_of_revenue`, `get_gross_profit`, `get_research_and_development`, `get_sga_expense`, `get_operating_expenses`, `get_operating_income`, `get_interest_expense`, `get_pretax_income`, `get_income_tax`, `get_net_income`, `get_eps`, `get_share_count`, `get_depreciation_and_amortization`, `get_stock_based_compensation`, `get_net_interest_income`, `get_credit_loss_provision`, `get_cash`, `get_total_assets`, `get_total_liabilities`, `get_debt`, `get_shareholders_equity`, `get_working_capital`, `get_goodwill_and_intangibles`, `get_inventories`, `get_accounts_receivable`, `get_accounts_payable`, `get_property_and_equipment`, `get_retained_earnings`, `get_operating_cash_flow`, `get_capital_expenditures`, `get_free_cash_flow`, `get_investing_and_financing_cash_flow`, `get_dividends`, `get_share_repurchases`, `get_acquisitions`

### Any figure

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_standard_figures` | none | The standard figure catalog: definitions, units, the tool for each, and every record name each is read from. |
| `list_company_figures` | `ticker`, `period?`, `block?` | Each standard figure mapped to this company's name for it, then every remaining figure under its own name, with values. |
| `find_figures` | `ticker`, `query`, `period?` | Fields whose names contain the words, e.g. `cet1`, `comparable sales`, `data center`. |
| `get_figure` | `ticker`, `figure`, `period?` | Any figure by its record name, path, standard name or words. A record name returns exactly that field. |
| `compare_companies` | `tickers`, `figure`, `period?` | One standard figure for two to ten companies, each row with its own period, dates and record name. |

### Sources and filings

| Tool | Arguments | Returns |
| --- | --- | --- |
| `get_source_filings` | `ticker`, `record?` | The annual and quarterly reports the record is built from, which filing each period came from, the sec.gov documents the figure links open, and the published files. |
| `get_accession_numbers` | `ticker`, `record?` | Every accession cited across statements, narrative and events: form, filing date, EDGAR index URL, and every use. |
| `get_filing` | `ticker`, `accession`, `record?` | One filing: form, date, links, the periods sourced from it, and the full text of every passage citing it. |
| `get_figure_source` | `ticker`, `figure`, `period?` | For each period, the accession, form and sec.gov line printing the figure. |

### Units, currency and conventions

| Tool | Arguments | Returns |
| --- | --- | --- |
| `get_reporting_conventions` | `ticker`, `record?` | Units, currency, business type and template, fiscal-year convention, sign conventions, accounting basis, definitions. |
| `get_fiscal_calendar` | `ticker` | Fiscal year end, 52/53-week detection, and every period's exact dates and length. |
| `get_currency_conversion` | `ticker`, `record?` | Reporting currency and, for a foreign issuer, the policy and each period's average and closing rate with its source. |
| `get_adr_details` | `ticker`, `record?` | ADR ratio, per-share basis and the ratio recorded on each period. |
| `get_stock_splits` | `ticker`, `record?` | Splits adjusted for, as-reported pre-split values, and notes about splits. |
| `get_data_notes` | `ticker`, `record?` | The record's own sourcing notes and period-level notes. |
| `get_data_gaps` | `ticker`, `record?` | Uncertainties, statements not reported, and which standard figures the latest periods lack. |
| `get_headline_summary` | `ticker`, `record?` | The written summary and Q&A for the latest period, with each metric's field and accession. |

### Filing schedule and coverage

| Tool | Arguments | Returns |
| --- | --- | --- |
| `get_next_filing` | `ticker` | Predicted next filing date and form, with the latest period and filing dates held. |
| `list_upcoming_filings` | `days?`, `form?` | Every covered company expected to file within N days, soonest first. |
| `get_coverage_summary` | none | Company count, update date, forms held, foreign issuers, records per company, URL patterns. |
| `guide` | none | How the tools fit together, the period syntax, units, citations and the full tool map. |

### 10-K and 10-Q narrative

| Tool | Arguments | Returns |
| --- | --- | --- |
| `get_business_overview` | `ticker`, `record?` | Item 1, condensed: products, segments, markets, customers, competition, supply chain, regulation. |
| `get_risk_factors` | `ticker`, `record?` | Item 1A, condensed and grouped, with changes since the prior filing flagged. |
| `get_annual_mdna` | `ticker`, `record?` | Management's discussion and analysis for the latest fiscal year. |
| `get_current_quarter` | `ticker`, `record?` | The latest quarterly report's MD&A: results, changes, liquidity, guidance. |
| `get_subsequent_events` | `ticker`, `record?` | Developments after the latest period end, dated and sourced. |
| `get_legal_proceedings` | `ticker`, `record?` | Every legal and regulatory section, subsection or passage, plus legal items from the 8-K digest. |
| `get_narrative_outline` | `ticker`, `record?` | The heading tree of the narrative and events documents. |
| `get_narrative_subsection` | `ticker`, `heading`, `record?` | One subsection by heading, e.g. Liquidity, Guidance, Competition. |

### 8-K events

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_events` | `ticker`, `record?` | Every item in the events digest with its date, accessions and first sentence. |
| `get_earnings_releases` | `ticker`, `record?` | Quarterly earnings releases and guidance. |
| `get_management_changes` | `ticker`, `record?` | Executive and board appointments, departures and successions. |
| `get_capital_return_events` | `ticker`, `record?` | Dividend declarations, buyback authorizations, accelerated repurchases. |
| `get_debt_and_financing_events` | `ticker`, `record?` | Notes offerings, credit facilities, term loans, commercial paper. |
| `get_mergers_and_acquisitions` | `ticker`, `record?` | Acquisitions, mergers, divestitures and spin-offs. |
| `get_governance_events` | `ticker`, `record?` | Annual meeting votes, bylaw and charter changes. |
| `get_restructuring_events` | `ticker`, `record?` | Restructuring plans, workforce reductions, impairments. |

### Search

| Tool | Arguments | Returns |
| --- | --- | --- |
| `search_sections` | `ticker`, `query`, `documents?`, `record?` | Which sections and subsections mention the query, ranked, with snippets. |
| `search_text` | `ticker`, `query`, `documents?`, `limit?`, `record?` | The paragraphs and list items that contain every word, in full. Quote a phrase to match it exactly. |

## Examples

```
> What did NVIDIA earn last quarter?

  get_key_figures(ticker: "NVDA")
```

```
> Apple's revenue for fiscal 2025, and where the 10-K prints it

  get_revenue(ticker: "AAPL", period: "FY2025")

  name_in_record  total_net_sales
  json_path       annual[0].income_statement.total_net_sales
  value           416161000000   ($416.16 billion)
  accession       0000320193-25-000079
  sec_link        https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250927.htm#f-78
```

```
> NVIDIA revenue in fiscal 2019

  get_revenue(ticker: "NVDA", period: "FY2019")

  available: false
  We don't have data going back that far: FY2019 is earlier than anything Ticker Scout
  holds for NVDA. The earliest fiscal year held is FY2024. ...
```

```
> NVIDIA Data Center revenue, every quarter held

  get_figure_history(ticker: "NVDA", figure: "Data Center")
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

`npm test` covers the pure logic. `test/smoke.mjs` calls the tools against a running server for a deliberately shape-diverse set of companies (a conventional company, a bank, an insurance conglomerate, a retailer far ahead of the calendar, a foreign issuer) plus negative cases. `test/sweep.mjs` runs every tool for every covered company in-process, serving the site's files from a local directory, and fails on any error.

## License

MIT. See [LICENSE](LICENSE).
