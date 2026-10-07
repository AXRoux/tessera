/** `bun run mcp`: Tessera's tools over stdio for any MCP client. Logs to stderr; stdout is protocol only. */
import { buildRuntime } from "../server/runtime";
import { serveStdio } from "./mcp";
import { createToolbox } from "./toolbox";

const { ledger, gateway, commander, closer, model, dbPath } = buildRuntime();
const actor = process.env.TESSERA_AGENT_NAME ?? "agent:mcp";

// Anything left in INTENT by a crash is resolved before the first tool call.
const resolved = await gateway.recover();
console.error(`tessera mcp  ledger ${dbPath}  |  actor ${actor}  |  reader ${model ? "on" : "off"}  |  recovered ${resolved.length}`);

await serveStdio(createToolbox({ ledger, gateway, commander, closer, model, actor }));
