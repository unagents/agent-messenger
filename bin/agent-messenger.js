#!/usr/bin/env node
import { brokerFetch, brokerHealth, getBrokerUrl } from "../src/client.js";
import { resolveBroker, discoverBrokers, readConfigBrokers } from "../src/resolve.js";
import { CONFIG_FILE } from "../src/config.js";

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
  agent-messenger discover            show how the broker is resolved and which brokers answer on the LAN

Broker resolution (mcp / status / peers / send), first hit wins:
  1. AGENT_MESSENGER_HOST (+AGENT_MESSENGER_PORT)   ("auto" or unset = continue)
  2. ${CONFIG_FILE}  {"brokers": ["http://host:7901", ...]}
  3. LAN discovery (UDP broadcast, port AGENT_MESSENGER_DISCOVERY_PORT=7902)
  4. 127.0.0.1:7901 (mcp auto-launches a local broker)

Environment:
  AGENT_MESSENGER_HOST / PORT / BIND / TOKEN / NAME / STATE / CONFIG
  AGENT_MESSENGER_BROKER_ID            broker id (default hostname)
  AGENT_MESSENGER_DISCOVERY=off        disable discovery (broker responder + client probe)
  AGENT_MESSENGER_DISCOVERY_PORT/ADDR/TIMEOUT_MS`);
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

const log = (m) => console.error(`[agent-messenger] ${m}`);

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
    const r = await resolveBroker(log);
    const h = await brokerHealth();
    if (!h) {
      console.log(`Broker at ${getBrokerUrl()} (via ${r.source}) is not running.`);
      process.exit(1);
    }
    console.log(`Broker: ${h.status} v${h.version} id=${h.id ?? "-"} (${h.peers} peer(s)) at ${getBrokerUrl()} (via ${r.source})`);
    if (h.peers > 0) printPeers(await brokerFetch("/list-peers", { scope: "all", cwd: "/", git_root: null }));
    break;
  }
  case "peers": {
    await resolveBroker(log);
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
    await resolveBroker(log);
    const r = await brokerFetch("/send-message", { from_id: "cli", from_name: "cli", to, text: message });
    if (!r.ok) {
      console.error(`Failed: ${r.error}`);
      process.exit(1);
    }
    console.log(`Message sent to ${r.to_name ? `${r.to_name} (${r.to_id})` : r.to_id}`);
    break;
  }
  case "discover": {
    const cfg = readConfigBrokers();
    console.log(`config file: ${CONFIG_FILE} → ${cfg.length ? cfg.join(", ") : "(none)"}`);
    const found = await discoverBrokers();
    console.log(`discovery: ${found.length} broker(s) answered`);
    for (const b of found) console.log(`  ${b.id}  ${b.url}  v${b.version}`);
    const r = await resolveBroker(log);
    console.log(`resolved: ${r.url} (via ${r.source})`);
    break;
  }
  default:
    usage();
    process.exit(cmd ? 1 : 0);
}
