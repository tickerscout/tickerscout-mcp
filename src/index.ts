import { createMcpHandler } from "@modelcontextprotocol/server";

import { challengeResponse, type ChallengeEnv } from "./challenge.ts";
import { createServer } from "./server.ts";

const mcp = createMcpHandler(createServer);

// The Workers runtime rejects a non-handler export from the entry module, so this module
// exports the handler object and nothing else. createMcpHandler's result is an object, not a
// function: its fetch is called, never the object itself.
export default {
  async fetch(request: Request, env: ChallengeEnv): Promise<Response> {
    return challengeResponse(request, env) ?? mcp.fetch(request);
  },
};
