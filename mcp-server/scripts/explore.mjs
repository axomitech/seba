// Manual exploration with the official MCP client: node scripts/explore.mjs <url> <token> <tool> '<json args>'
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
const [url, token, tool, args] = process.argv.slice(2);
const client = new Client({ name: "explore", version: "0.0.1" });
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
if (!tool) { console.log((await client.listTools()).tools.map((t) => t.name).join("\n")); }
else { const r = await client.callTool({ name: tool, arguments: args ? JSON.parse(args) : {} }); console.log(JSON.stringify(r.structuredContent ?? r, null, 1).slice(0, 3500)); if (r.isError) process.exitCode = 1; }
await client.close();
