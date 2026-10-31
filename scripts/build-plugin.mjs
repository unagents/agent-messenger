// plugins/messenger の版を packages/cli/package.json に合わせる（冪等）。
//   node scripts/build-plugin.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, v) => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);

const version = readJson(join(root, "packages/cli/package.json")).version;
if (typeof version !== "string" || version === "") throw new Error("packages/cli/package.json: version missing");

const pluginJson = join(root, "plugins/messenger/.claude-plugin/plugin.json");
const plugin = readJson(pluginJson);
plugin.version = version;
writeJson(pluginJson, plugin);

const mcpJson = join(root, "plugins/messenger/.mcp.json");
const mcp = readJson(mcpJson);
const server = mcp.mcpServers?.["agent-messenger"];
if (!server) throw new Error(".mcp.json: mcpServers.agent-messenger missing");
server.args = server.args.map((a) => (a.startsWith("@unagents/messenger@") ? `@unagents/messenger@${version}` : a));
server.env = { ...server.env, AGENT_MESSENGER_CLIENT_SPEC: version };
writeJson(mcpJson, mcp);

console.log(`plugin version: ${version}`);
