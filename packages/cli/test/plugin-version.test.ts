import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const readJson = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));

const version: string = readJson("packages/cli/package.json").version;

describe("plugins/messenger version", () => {
  it("plugin.json matches the CLI package version", () => {
    expect(readJson("plugins/messenger/.claude-plugin/plugin.json").version).toBe(version);
  });

  it(".mcp.json pins the CLI and the client to the CLI package version", () => {
    const server = readJson("plugins/messenger/.mcp.json").mcpServers["agent-messenger"];
    expect(server.args).toContain(`@unagents/messenger@${version}`);
    expect(server.env.AGENT_MESSENGER_CLIENT_SPEC).toBe(version);
  });
});
