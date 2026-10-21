import { test } from "node:test";
import assert from "node:assert/strict";
import { INPUTS_MAX, callTickers, recordCalls, scrub, scrubInputs, setToolCallSink } from "../src/record.ts";

function fakeSink() {
  const points = [];
  return { points, writeDataPoint: (p) => points.push(p) };
}

test("scrub removes email addresses and phone, card and account numbers", () => {
  for (const text of [
    "email me at jane.doe@example.com",
    "call (555) 123-4567",
    "call +1 555 123 4567",
    "ssn 123-45-6789",
    "card 4111 1111 1111 1111",
    "account 004512345678",
  ]) {
    assert.match(scrub(text), /\[redacted\]/, text);
    assert.doesNotMatch(scrub(text), /\d{3}.?\d{4}|@example/, text);
  }
});

test("scrub leaves tickers, periods, dates and reported figures alone", () => {
  for (const text of [
    "data center revenue",
    "BRK.B",
    "Q2 FY2027",
    "FY27Q2",
    "2026-06-27",
    "$24,809,695",
    "10-K risk factors",
    "fiscal 2025 vs 2024",
  ]) {
    assert.equal(scrub(text), text);
  }
});

test("accession numbers are kept, since they name a filing", () => {
  const inputs = scrubInputs({ ticker: "nvda", accession: "0001045810-26-000073" });
  assert.equal(inputs.accession, "0001045810-26-000073");
});

test("scrubInputs reaches strings inside arrays", () => {
  assert.deepEqual(scrubInputs({ tickers: ["AAPL", "me@example.com"] }), { tickers: ["AAPL", "[redacted]"] });
});

test("callTickers names every ticker a call asks about, as the site writes them", () => {
  assert.equal(callTickers({ ticker: "brk.b" }), "BRK-B");
  assert.equal(callTickers({ tickers: ["nvda", "AMD", "NVDA"] }), "NVDA,AMD");
  assert.equal(callTickers({ query: "apple" }), "");
});

test("a successful call writes one data point: tool, tickers, inputs, outcome, version", async () => {
  const sink = fakeSink();
  setToolCallSink(sink);
  const handler = recordCalls("get_financials", async () => ({ content: [] }), true, "9.9.9");
  await handler({ ticker: "nvda", sections: ["income_statement"] }, {});
  setToolCallSink(undefined);
  assert.equal(sink.points.length, 1);
  assert.deepEqual(sink.points[0], {
    indexes: ["get_financials"],
    blobs: ["get_financials", "NVDA", '{"ticker":"nvda","sections":["income_statement"]}', "ok", "9.9.9"],
  });
});

test("the request context is never recorded", async () => {
  const sink = fakeSink();
  setToolCallSink(sink);
  const ctx = { requestInfo: { headers: { "cf-connecting-ip": "203.0.113.7", "user-agent": "Claude-User" } } };
  await recordCalls("get_company", async () => ({ content: [] }), true, "1")({ ticker: "aapl" }, ctx);
  await recordCalls("no_inputs", async () => ({ content: [] }), false, "1")(ctx);
  setToolCallSink(undefined);
  const written = JSON.stringify(sink.points);
  assert.doesNotMatch(written, /203\.0\.113\.7|Claude-User|requestInfo/);
  assert.equal(sink.points[1].blobs[2], "{}");
});

test("a tool error is recorded as error, and a thrown error as exception and rethrown", async () => {
  const sink = fakeSink();
  setToolCallSink(sink);
  await recordCalls("t", async () => ({ content: [], isError: true }), true, "1")({}, {});
  await assert.rejects(recordCalls("t", async () => { throw new Error("boom"); }, true, "1")({}, {}), /boom/);
  setToolCallSink(undefined);
  assert.deepEqual(sink.points.map((p) => p.blobs[3]), ["error", "exception"]);
});

test("recording never costs the caller the answer", async () => {
  setToolCallSink({ writeDataPoint() { throw new Error("dataset down"); } });
  const result = await recordCalls("t", async () => ({ content: [{ type: "text", text: "ok" }] }), true, "1")({}, {});
  setToolCallSink(undefined);
  assert.equal(result.content[0].text, "ok");
});

test("with no dataset bound, calls run and nothing is written", async () => {
  setToolCallSink(undefined);
  const result = await recordCalls("t", async () => ({ content: [] }), true, "1")({}, {});
  assert.deepEqual(result, { content: [] });
});

test("long inputs are cut to INPUTS_MAX", async () => {
  const sink = fakeSink();
  setToolCallSink(sink);
  await recordCalls("search_text", async () => ({ content: [] }), true, "1")({ query: "x".repeat(10_000) }, {});
  setToolCallSink(undefined);
  assert.equal(sink.points[0].blobs[2].length, INPUTS_MAX);
});

test("a tools/call through the real server is recorded", async () => {
  const { createMcpHandler } = await import("@modelcontextprotocol/server");
  const { createServer, SERVER_VERSION } = await import("../src/server.ts");
  const sink = fakeSink();
  setToolCallSink(sink);
  const handler = createMcpHandler(createServer);
  const req = new Request("http://local/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "guide", arguments: {} } }),
  });
  await (await handler.fetch(req)).text();
  setToolCallSink(undefined);
  assert.equal(sink.points.length, 1);
  assert.deepEqual(sink.points[0].blobs, ["guide", "", "{}", "ok", SERVER_VERSION]);
});
