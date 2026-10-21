import { normalizeTicker } from "./tickers.ts";

/**
 * One Analytics Engine data point per tool call: which tool, when (Analytics Engine stamps
 * the time), the inputs it was called with, and whether it succeeded.
 *
 * The privacy policy (tickerscout.ai/privacy, "MCP Server") says these records include no IP
 * address. Only the tool's own arguments are read here, never the SDK's request context,
 * which is where the request and its headers live. Do not add the context, a header, or any
 * value that ties one call to another caller's calls without changing that policy first.
 *
 * Blobs, in order (readers of the dataset rely on these positions):
 *   blob1 tool   blob2 tickers   blob3 inputs (JSON)   blob4 outcome   blob5 server version
 */

/** The slice of Analytics Engine's dataset binding this module uses. */
export interface ToolCallSink {
  writeDataPoint(point: { indexes?: string[]; blobs?: string[] }): void;
}

let sink: ToolCallSink | undefined;

/** Set from the Worker's binding on each request. Unset (tests, local dev) records nothing. */
export function setToolCallSink(next: ToolCallSink | undefined): void {
  sink = next;
}

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
// Nine or more digits, with the separators phone, card and account numbers are written with.
// Dates and reported figures stay under it: a date has eight digits, and commas break a figure.
const LONG_NUMBER = /\+?\d(?:[\s().-]{0,2}\d){8,}/g;
// An accession number is eighteen digits and names a filing, not a person.
const UNSCRUBBED = new Set(["accession"]);

/** Analytics Engine allows 16 KB of blobs per data point; inputs get most of it. */
export const INPUTS_MAX = 2000;

export function scrub(text: string): string {
  return text.replace(EMAIL, "[redacted]").replace(LONG_NUMBER, "[redacted]");
}

function scrubValue(value: unknown): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value && typeof value === "object") return scrubInputs(value as Record<string, unknown>);
  return value;
}

export function scrubInputs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = UNSCRUBBED.has(key) ? value : scrubValue(value);
  return out;
}

/** Every ticker a call names, upper-cased the way the site writes them (BRK.B -> BRK-B). */
export function callTickers(args: Record<string, unknown>): string {
  const named = [args.ticker, args.tickers].flat().filter((t): t is string => typeof t === "string");
  return [...new Set(named.map((t) => normalizeTicker(t).toUpperCase()))].join(",");
}

function write(tool: string, args: Record<string, unknown>, outcome: string, version: string): void {
  if (!sink) return;
  try {
    const inputs = scrubInputs(args);
    sink.writeDataPoint({
      indexes: [tool],
      blobs: [tool, callTickers(inputs), JSON.stringify(inputs).slice(0, INPUTS_MAX), outcome, version],
    });
  } catch {
    // Recording must never cost a caller the answer.
  }
}

type Handler = (...params: unknown[]) => Promise<{ isError?: boolean }>;

/**
 * Wraps a tool handler so each call is recorded. The SDK calls a handler as (args, ctx) when
 * the tool has an input schema and as (ctx) alone when it has none, so `takesArgs` says which
 * parameter, if any, holds the arguments. Calls whose arguments fail the schema never reach
 * the handler and are not recorded.
 */
export function recordCalls(tool: string, handler: Handler, takesArgs: boolean, version: string): Handler {
  return async (...params) => {
    const args = takesArgs ? ((params[0] ?? {}) as Record<string, unknown>) : {};
    let outcome = "exception";
    try {
      const result = await handler(...params);
      outcome = result?.isError ? "error" : "ok";
      return result;
    } finally {
      write(tool, args, outcome, version);
    }
  };
}
