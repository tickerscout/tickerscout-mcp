import { McpServer } from "@modelcontextprotocol/server";

import { registerCoreTools } from "./tools/core.ts";
import { registerStatementTools } from "./tools/statements.ts";
import { registerFigureTools } from "./tools/figures.ts";
import { registerReferenceTools } from "./tools/reference.ts";
import { registerDocumentTools } from "./tools/documents.ts";

export const SERVER_VERSION = "2.0.0";

type ToolDefinition = [name: string, config: unknown, handler: unknown];

let definitions: ToolDefinition[] | null = null;

/**
 * Every tool's name, config and handler, built ONCE per isolate.
 *
 * createMcpHandler calls createServer for every request. Building ~100 tool configs (each
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
      collected.push([name, config, handler]);
    },
  } as unknown as McpServer;
  registerCoreTools(collector);
  registerStatementTools(collector);
  registerFigureTools(collector);
  registerReferenceTools(collector);
  registerDocumentTools(collector);
  definitions = collected;
  return collected;
}

/**
 * Registration order is the order clients list the tools in: the main six tools
 * first, then periods and statements, one tool per line item, sources and conventions,
 * and the narrative, events and search tools last.
 *
 * Kept out of index.ts because a Worker's entry module may export only handlers.
 */
export function createServer() {
  const server = new McpServer({ name: "ticker-scout", version: SERVER_VERSION });
  const register = server.registerTool.bind(server) as unknown as (n: string, c: unknown, h: unknown) => void;
  for (const [name, config, handler] of toolDefinitions()) register(name, config, handler);
  return server;
}

/** Tool names in registration order, for tests and the docs. */
export function toolNames(): string[] {
  return toolDefinitions().map(([name]) => name);
}
