// Receiver peer for the playground measurement.
// Starts `<cli> mcp` (env must already point to the loopback broker), polls check_messages once a second
// and prints each result line. Exits 0 when MARKER shows up, 1 after TIMEOUT_MS.
// usage: node cli-peer.mjs <path-to-cli/dist/main.mjs> <marker> [timeoutMs]
import { spawn } from "node:child_process";

const [cli, marker, timeoutArg] = process.argv.slice(2);
if (!cli || !marker) {
  console.error("usage: node cli-peer.mjs <cli-main.mjs> <marker> [timeoutMs]");
  process.exit(2);
}
const timeoutMs = Number(timeoutArg ?? 90000);

const proc = spawn(process.execPath, [cli, "mcp"], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
let nextId = 1;
const pending = new Map();
proc.stdout.setEncoding("utf8").on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    try {
      const msg = JSON.parse(line);
      if (typeof msg.id === "number" && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      }
    } catch {
      // ignore non-JSON lines
    }
  }
});
proc.stderr.setEncoding("utf8").on("data", (d) => process.stderr.write(`[cli-peer stderr] ${d}`));

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function finish(code) {
  proc.kill("SIGTERM");
  setTimeout(() => process.exit(code), 200);
}

await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cli-peer", version: "0" } });
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
console.log("cli-peer ready");

const t0 = Date.now();
while (Date.now() - t0 < timeoutMs) {
  const r = await request("tools/call", { name: "check_messages", arguments: {} });
  const text = r.content.map((c) => c.text).join("\n");
  if (!text.startsWith("No new messages")) console.log(text);
  if (text.includes(marker)) {
    console.log(`cli-peer: marker ${marker} received`);
    finish(0);
    break;
  }
  await new Promise((r2) => setTimeout(r2, 1000));
}
if (Date.now() - t0 >= timeoutMs) {
  console.log(`cli-peer: timeout without ${marker}`);
  finish(1);
}
