import { test } from "node:test";
import assert from "node:assert/strict";
import { SERVER_VERSION, toolNames } from "../src/server.ts";
import { TOOL_MAP } from "../src/tools/core.ts";
import { readFileSync } from "node:fs";

const CORE = ["list_companies", "get_company", "get_key_figures", "get_financials", "get_narrative", "get_events"];

test("the main six tools are registered first, in order", () => {
  assert.deepEqual(toolNames().slice(0, 6), CORE);
});

test("tool names are unique", () => {
  const names = toolNames();
  assert.equal(new Set(names).size, names.length);
});

test("the tool map handed to agents names only tools that exist, and every tool appears in it", () => {
  const names = new Set(toolNames());
  const mapped = new Set(
    Object.values(TOOL_MAP)
      .flat()
      .flatMap((line) => line.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [])
      .filter((w) => /^(get|list|find|search|compare)_/.test(w)),
  );
  for (const m of mapped) assert.ok(names.has(m), `TOOL_MAP names a tool that does not exist: ${m}`);
  for (const n of names) if (n !== "guide") assert.ok(mapped.has(n), `TOOL_MAP leaves out ${n}`);
});

test("server.json, package.json and the handshake report the same version", () => {
  const server = JSON.parse(readFileSync(new URL("../server.json", import.meta.url)));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  assert.equal(server.version, SERVER_VERSION);
  assert.equal(pkg.version, SERVER_VERSION);
  assert.ok(server.description.length <= 100, "the registry rejects a description over 100 characters");
});

test("the registry description's tool count is the number of tools registered", () => {
  const server = JSON.parse(readFileSync(new URL("../server.json", import.meta.url)));
  const m = /(\d+) tools/.exec(server.description);
  if (m) assert.equal(Number(m[1]), toolNames().length);
});

test("tools/list stays small enough to sit in an agent's context", async () => {
  // 2.0 listed 97 tools in ~150 KB (~38k tokens) and overlapped heavily; 3.0 folded them into
  // arguments. Keep the listing near its 3.0 size: a new capability should be an argument on
  // an existing tool before it is a tool of its own.
  const { createMcpHandler } = await import("@modelcontextprotocol/server");
  const { createServer } = await import("../src/server.ts");
  const handler = createMcpHandler(createServer);
  const req = new Request("http://local/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const res = await handler.fetch(req, {}, { waitUntil() {}, passThroughOnException() {} });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: ")) ?? text;
  const { result } = JSON.parse(line.replace(/^data: /, ""));
  assert.ok(result.tools.length <= 30, `${result.tools.length} tools`);
  assert.ok(JSON.stringify(result).length < 40_000, `${JSON.stringify(result).length} bytes`);
});

test("every tool states all three safety hints as explicit booleans", async () => {
  // ChatGPT's plugin review requires readOnlyHint, destructiveHint and openWorldHint on every tool.
  const { createMcpHandler } = await import("@modelcontextprotocol/server");
  const { createServer } = await import("../src/server.ts");
  const handler = createMcpHandler(createServer);
  const req = new Request("http://local/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const text = await (await handler.fetch(req)).text();
  const line = text.split("\n").find((l) => l.startsWith("data: ")) ?? text;
  for (const t of JSON.parse(line.replace(/^data: /, "")).result.tools) {
    for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"]) {
      assert.equal(typeof t.annotations?.[hint], "boolean", `${t.name} ${hint}`);
    }
    assert.equal(t.annotations.readOnlyHint, true, t.name);
    assert.equal(t.annotations.destructiveHint, false, t.name);
    // Plugin directories forbid descriptions that steer the model toward this server over others.
    assert.doesNotMatch(t.description, /\bprefer (it|this)\b|\binstead of (EDGAR|the SEC)|CompanyFacts/i, t.name);
  }
});

test("the server sends instructions, with the essentials in the first 512 characters", async () => {
  const { SERVER_INSTRUCTIONS } = await import("../src/server.ts");
  assert.ok(SERVER_INSTRUCTIONS.length <= 512, String(SERVER_INSTRUCTIONS.length));
  for (const must of ["actual dollars", "accession", "investment advice"]) assert.ok(SERVER_INSTRUCTIONS.includes(must), must);
});
