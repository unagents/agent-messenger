#!/usr/bin/env node
/**
 * `npx -y @unagents/messenger <mcp|broker|status|peers|send|discover>`
 *
 * Fetches the broker / client packages from Gitea Packages (see config.ts / pkgs.ts),
 * caches them under ~/.agent-messenger/pkgs/ and runs them. `mcp` is the default.
 */
import { defineCommand, runMain } from "citty";
import { runBroker, runDiscover, runMcp, runPeers, runSend, runStatus } from "./commands.js";
import { DEFAULT_REGISTRY, ENV, loadLoaderConfig } from "./config.js";
import { VERSION } from "./version.js";

const mcp = defineCommand({
  meta: { name: "mcp", description: "stdio MCP server (register in Claude Code); native client if available, else node" },
  run: () => runMcp(loadLoaderConfig()),
});

const broker = defineCommand({
  meta: { name: "broker", description: "run the broker daemon (foreground)" },
  run: () => runBroker(loadLoaderConfig()),
});

const status = defineCommand({
  meta: { name: "status", description: "broker health + peers" },
  run: () => runStatus(loadLoaderConfig()),
});

const peers = defineCommand({
  meta: { name: "peers", description: "list peers" },
  run: () => runPeers(loadLoaderConfig()),
});

const send = defineCommand({
  meta: { name: "send", description: 'send <name|id> <message...> — send a message into a session (from "cli")' },
  run: ({ rawArgs }) => runSend(loadLoaderConfig(), rawArgs),
});

const discover = defineCommand({
  meta: { name: "discover", description: "show how the broker is resolved and which brokers answer on the LAN" },
  run: () => runDiscover(loadLoaderConfig()),
});

const main = defineCommand({
  meta: {
    name: "agent-messenger",
    version: VERSION,
    description: `agent-messenger — Claude Code session messaging (cross-host). Packages: ${ENV.REGISTRY} (default ${DEFAULT_REGISTRY}), specs ${ENV.BROKER_SPEC} / ${ENV.CLIENT_SPEC} (default latest), cache ${ENV.PKGS_DIR}, ${ENV.REFRESH}=1 reinstalls, ${ENV.CLIENT}=node|native`,
  },
  subCommands: { mcp, broker, status, peers, send, discover },
  run: ({ rawArgs }) => {
    // citty runs the parent after a sub-command; only act when none was named (default = mcp)
    if (rawArgs.some((a) => !a.startsWith("-"))) return;
    return runMcp(loadLoaderConfig());
  },
});

runMain(main);
