# Ticker Scout MCP server

Finished financial statements for US public companies, over the Model Context Protocol. The SEC publishes the numbers as data, but it does not publish them as statements. This serves them already assembled. No API key, no signup, no paywall.

```
https://mcp.tickerscout.ai/mcp
```

It exposes the data published at tickerscout.ai ([https://tickerscout.ai](https://tickerscout.ai)) as six tools: financial statements, annual and quarterly report summaries, and material event histories for a growing set of US public companies, all derived from their own filings with the SEC.

## What is already done for you

The difference between this and the EDGAR APIs is assembly, not availability. The SEC gives you facts. This gives you statements.

- **The three statements arrive as statements.** Income statement, balance sheet and cash flow, line items in reported order, not a flat bag of tagged facts you have to select concepts for and group yourself.
- **Assembled across filings, because no single filing holds the whole record.** Annual figures come from the annual report, quarterly and year-to-date figures from the quarterly report, and where a quarterly report presents cash flow only on a year-to-date basis, the discrete quarter comes from the earnings release filed as a current-report exhibit. For a US filer that means the 10-K, the 10-Q and the 8-K. Every company covered needed at least two filings to complete its record.
- **On the company's own fiscal calendar.** 52- and 53-week years, quarters that are 13-week periods rather than calendar quarters, and fiscal years that do not end in December. Period dates come from the column headings the filings themselves print.
- **In actual dollars and actual shares.** Never thousands, never millions, no scale factor to infer. Share counts are adjusted for splits.
- **Shaped to the business.** A bank, an insurer, an asset manager and a retailer do not have the same statements, so they do not get the same sections. Ask what a company has rather than assuming a fixed shape.
- **With the gaps named.** Where a filing does not disclose a figure it is omitted and the omission is explained, never silently zeroed. Every figure cites the SEC accession number it came from, so anything the server returns can be checked against sec.gov.

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

## Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_companies` | `query` (optional) | Every covered company with its latest fiscal period and next expected filing. Resolves a company name to a ticker. |
| `get_company` | `ticker` | Identity and coverage manifest: name, CIK, exchange, SIC industry, fiscal period held, source accession. |
| `get_key_figures` | `ticker` | Headline figures for the latest reported period, each with its year-over-year change, exact amount and source accession. |
| `get_financials` | `ticker`, `sections` (optional) | Income statement, balance sheet, cash flow, segment revenue, per-share figures. |
| `get_narrative` | `ticker`, `section` (optional) | Business, risk factors, MD&A, legal proceedings, subsequent events from the latest 10-K and 10-Q. |
| `get_events` | `ticker`, `section` (optional) | Material 8-K filings over roughly the trailing five quarters. |

Tickers are case-insensitive, and `BRK.B` and `BRK-B` both resolve.

### Section slicing

This is the reason to use the server rather than fetching the files directly. `financials.json` averages 58KB and `narrative.md` averages 38KB, and a question usually needs one part of one of them.

`get_narrative` called without a section returns an index of the document's sections with a one-line summary of each, so an agent can pick one and fetch only that. Pass `section: "all"` for the whole thing.

`get_financials` called without sections returns the whole file, and `available_sections` in the response lists what that company has. Section names are not the same across companies: a bank carries different top-level keys from a semiconductor company, and an insurer from both. Ask for what is there rather than guessing.

Every `get_financials` response includes a `meta` header with the company's units, reporting currency and fiscal period, even when you ask for a single section. All money is in actual dollars, not millions, and all share counts are actual shares.

## Example

```
> What did NVIDIA earn last quarter?

  get_key_figures(ticker: "NVDA")

  Q1 FY2027, ended April 26, 2026
  Revenue           $81,615,000,000   up 85.2%
  Net income        $58,321,000,000   up 210.6%
  Diluted EPS       $2.39             up 214.5%
  Operating income  $53,536,000,000   up 147.4%
  Gross margin      74.9%             up 14.4 points
  All from SEC accession 0001045810-26-000052
```

## Data policy

- Everything is derived from public reports filed with the SEC, such as annual reports on Form 10-K, quarterly reports on Form 10-Q and current reports on Form 8-K. Nothing is estimated and nothing is fabricated. Where a filing does not disclose a figure, it is omitted and the omission is explained.
- No market price data. No quotes, no market caps, no price snapshots. This is a fundamentals source.
- Data is refreshed each quarter, shortly after a company files. Coverage and the period held for each company are in `list_companies`.
- This is factual synthesis of public filings. It is not investment advice.

Free to read and cite. Please attribute "Ticker Scout (tickerscout.ai)".

## How it works

A stateless Cloudflare Worker using `createMcpHandler` from `@modelcontextprotocol/server`, speaking streamable HTTP at `/mcp`.

The server stores no data. Every tool call fetches the corresponding file from `https://tickerscout.ai` through the Cloudflare edge cache and shapes the response. There is no database, no snapshot and no fallback copy: if the upstream file cannot be fetched, the tool returns an error naming the URL and the status rather than serving something stale.

```
src/
  index.ts       Worker entrypoint, tool registration
  upstream.ts    Fetching, edge caching, the error policy
  tickers.ts     Ticker normalization, coverage search, near matches
  markdown.ts    Section parsing for the .md documents
  financials.ts  Headline condensing and unit-safe slicing
  respond.ts     Result shaping, source URL and attribution
```

## Development

```
npm install
npm test          # unit tests for the pure modules
npm run dev       # local server on http://localhost:8787/mcp
npm run smoke     # live end-to-end check, pass a URL to target a deployment
npm run deploy
```

`npm test` covers the pure logic. `test/smoke.mjs` calls every tool against a running server for a deliberately shape-diverse set of companies plus three negative cases, and is the check that matters before shipping.

## License

MIT. See [LICENSE](LICENSE).
