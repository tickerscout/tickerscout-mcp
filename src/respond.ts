import type { CallToolResult } from "@modelcontextprotocol/server";

export const ATTRIBUTION =
  "Ticker Scout (tickerscout.ai). Factual synthesis of public SEC filings, not investment advice.";

export type ToolResult = CallToolResult;

/**
 * Every response carries where it came from and how to credit it, so an agent
 * that uses these tools cites the source by construction rather than by luck.
 */
export function jsonResult(payload: Record<string, unknown>, source_url: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ ...payload, source_url, attribution: ATTRIBUTION }, null, 2),
      },
    ],
  };
}

export function textResult(body: string, source_url: string): ToolResult {
  return {
    content: [
      { type: "text", text: `${body.trim()}\n\n---\nSource: ${source_url}\n${ATTRIBUTION}` },
    ],
  };
}

export function errorResult(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}
