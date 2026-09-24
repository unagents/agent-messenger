#!/usr/bin/env node
import { BROKER_URL } from "../src/config.js";
import { brokerFetch, brokerHealth } from "../src/client.js";

const [cmd, ...rest] = process.argv.slice(2);

function usage() {
  console.log(`agent-messenger — Claude Code session messaging (cross-host)

Usage:
  agent-messenger mcp                 stdio MCP server (register in Claude Code)
  agent-messenger broker              run the broker daemon (foreground)
  agent-messenger status              broker health + peers
  agent-messenger peers               list peers
  agent-messenger send <name|id> <message...>
                                      send a message into a session (from "cli")

Environment:
  AGENT_MESSENGER_HOST   broker host (default 127.0.0.1)
  AGENT_MESSENGER_PORT   broker port (default 7901)
  AGENT_MESSENGER_BIND   broker bind address (default 0.0.0.0)
  AGENT_MESSENGER_TOKEN  bearer token
  AGENT_MESSENGER_NAME   peer name for this session
  AGENT_MESSENGER_STATE  broker state file (default ~/.agent-messenger/broker.json)`);
}

function printPeers(peers) {
  if (peers.length === 0) {
    console.log("No peers registered.");
    return;
  }
  for (const p of peers) {
    console.log(`${p.id}  ${p.name || "-"}  ${p.hostname}  PID:${p.pid}  ${p.cwd}`);
    if (p.summary) console.log(`    ${p.summary}`);
    console.log(`    last seen: ${p.last_seen}`);
  }
}

switch (cmd) {
  case "mcp": {
    const { startMcpServer } = await import("../src/server.js");
    await startMcpServer();
    break;
  }
  case "broker": {
    const { startBroker } = await import("../src/broker.js");
    startBroker();
    break;
  }
  case "status": {
    const h = await brokerHealth();
    if (!h) {
      console.log(`Broker at ${BROKER_URL} is not running.`);
      process.exit(1);
    }
    console.log(`Broker: ${h.status} v${h.version} (${h.peers} peer(s)) at ${BROKER_URL}`);
    if (h.peers > 0) printPeers(await brokerFetch("/list-peers", { scope: "all", cwd: "/", git_root: null }));
    break;
  }
  case "peers": {
    printPeers(await brokerFetch("/list-peers", { scope: "all", cwd: "/", git_root: null }));
    break;
  }
  case "send": {
    const [to, ...words] = rest;
    const message = words.join(" ");
    if (!to || !message) {
      console.error("Usage: agent-messenger send <name|id> <message...>");
      process.exit(1);
    }
    const r = await brokerFetch("/send-message", { from_id: "cli", from_name: "cli", to, text: message });
    if (!r.ok) {
      console.error(`Failed: ${r.error}`);
      process.exit(1);
    }
    console.log(`Message sent to ${r.to_name ? `${r.to_name} (${r.to_id})` : r.to_id}`);
    break;
  }
  default:
    usage();
    process.exit(cmd ? 1 : 0);
}
