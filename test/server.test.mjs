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
