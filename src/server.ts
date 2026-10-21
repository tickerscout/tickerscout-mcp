import { McpServer } from "@modelcontextprotocol/server";

import { registerCoreTools } from "./tools/core.ts";
import { registerStatementTools } from "./tools/statements.ts";
import { registerFigureTools } from "./tools/figures.ts";
import { registerReferenceTools } from "./tools/reference.ts";
import { registerDocumentTools } from "./tools/documents.ts";
import { recordCalls } from "./record.ts";

export const SERVER_VERSION = "3.0.1";

/**
 * Guidance that applies across tools, sent once at initialization. ChatGPT reads the first
 * 512 characters most closely, so the units, the citation and the limits come first.
 */
export const SERVER_INSTRUCTIONS =
  "Financial statements and filing summaries for public companies, assembled from their SEC " +
  "filings (10-K, 10-Q, 8-K; 20-F and 6-K for foreign issuers). All money is in actual dollars, " +
  "not millions. Every figure carries the SEC accession number of its filing; cite it, and the " +
  "sec_link where one is given. Fiscal years and quarters are each company's own. There are no " +
  "stock prices, market data or estimates, and nothing here is investment advice. If unsure which " +
  "tool fits, call guide.";

type ToolDefinition = [name: string, config: unknown, handler: unknown];

let definitions: ToolDefinition[] | null = null;

/**
 * Every tool's name, config and handler, built ONCE per isolate.
 *
 * createMcpHandler calls createServer for every request. Building the tool configs (each
 * with its zod input schema) per request doubled the CPU a request costs: measured median
 * 1.76 ms for a ping with fresh configs against 0.88 ms with shared ones, and the Workers
 * free plan allows 10 ms of CPU per request. Handlers close over nothing per-request, so
 * sharing them is safe; each request still gets its own McpServer.
 */
function toolDefinitions(): ToolDefinition[] {
  if (definitions) return definitions;
  const collected: ToolDefinition[] = [];
  const collector = {
    registerTool: (name: string, config: unknown, handler: unknown) => {
      const takesArgs = (config as { inputSchema?: unknown }).inputSchema !== undefined;
      collected.push([name, config, recordCalls(name, handler as Parameters<typeof recordCalls>[1], takesArgs, SERVER_VERSION)]);
    },
  } as unknown as McpServer;
  registerCoreTools(collector);
  registerStatementTools(collector);
  registerFigureTools(collector);
  registerDocumentTools(collector);
  registerReferenceTools(collector);
  definitions = collected;
  return collected;
}

/**
 * Registration order is the order clients list the tools in: the main six tools first,
 * then statements and periods, figures, search, and filings, conventions and the guide.
 *
 * Kept out of index.ts because a Worker's entry module may export only handlers.
 */
export function createServer() {
  const server = new McpServer({ name: "ticker-scout", version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  const register = server.registerTool.bind(server) as unknown as (n: string, c: unknown, h: unknown) => void;
  for (const [name, config, handler] of toolDefinitions()) register(name, config, handler);
  return server;
}

/** Tool names in registration order, for tests and the docs. */
export function toolNames(): string[] {
  return toolDefinitions().map(([name]) => name);
}
