import { createMcpHandler } from "@modelcontextprotocol/server";

import { createServer } from "./server.ts";

// createMcpHandler returns a `{ fetch, close, notify, bus }` object, which is
// already the shape Workers expects from a default export. This module must
// export nothing else: the Workers runtime rejects a non-handler export here.
export default createMcpHandler(createServer);
