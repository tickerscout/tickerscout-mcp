import { test } from "node:test";
import assert from "node:assert/strict";
import { CHALLENGE_PATH, challengeResponse } from "../src/challenge.ts";

const at = (path, method = "GET") => new Request(`https://mcp.tickerscout.ai${path}`, { method });

test("the challenge path returns the token alone, as plain text", async () => {
  const res = challengeResponse(at(CHALLENGE_PATH), { OPENAI_APPS_CHALLENGE: " abc123\n" });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "abc123");
  assert.match(res.headers.get("Content-Type"), /^text\/plain/);
});

test("with no token set the challenge path is a 404, not an empty 200", () => {
  assert.equal(challengeResponse(at(CHALLENGE_PATH), {}).status, 404);
  assert.equal(challengeResponse(at(CHALLENGE_PATH), undefined).status, 404);
});

test("every other request passes through to the MCP handler", () => {
  assert.equal(challengeResponse(at("/mcp", "POST"), { OPENAI_APPS_CHALLENGE: "abc" }), null);
  assert.equal(challengeResponse(at("/.well-known/other"), { OPENAI_APPS_CHALLENGE: "abc" }), null);
});
