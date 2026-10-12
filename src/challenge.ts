/**
 * OpenAI's plugin portal proves we control the MCP hostname by fetching a token it issues
 * from this path. The token lives in the Worker secret OPENAI_APPS_CHALLENGE, so changing
 * it is `wrangler secret put OPENAI_APPS_CHALLENGE` with no code change. The response is the
 * token alone, as plain text: the portal rejects JSON or a list.
 */
export const CHALLENGE_PATH = "/.well-known/openai-apps-challenge";

export interface ChallengeEnv {
  OPENAI_APPS_CHALLENGE?: string;
}

/** The challenge response for this request, or null when the request is not for it. */
export function challengeResponse(request: Request, env: ChallengeEnv | undefined): Response | null {
  if (new URL(request.url).pathname !== CHALLENGE_PATH) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const token = env?.OPENAI_APPS_CHALLENGE?.trim();
  if (!token) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  return new Response(request.method === "HEAD" ? null : token, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
