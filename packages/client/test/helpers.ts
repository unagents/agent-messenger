/**
 * Test helpers: spawn the TypeScript broker (`packages/broker/dist/main.mjs`; the legacy JavaScript
 * broker drops the per-message `mode`)
 * and drive the client (node `dist/main.mjs`, or the native binary named by
 * `AGENT_MESSENGER_CLIENT_BIN`) over stdio JSON-RPC without the MCP SDK.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const BROKER_BIN = `${ROOT}packages/broker/dist/main.mjs`;
export const CLIENT_MAIN = fileURLToPath(new URL("../dist/main.mjs", import.meta.url));

/** never let the tests post into a real Claude Code session the runner may be a child of */
export function baseEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CLAUDE_CODE_MESSAGING_SOCKET;
  delete env.CLAUDE_CODE_MESSAGING_TOKEN;
  delete env.AGENT_MESSENGER_DELIVERY;
  delete env.AGENT_MESSENGER_BROKER_CMD;
  for (const k of Object.keys(env)) if (k.startsWith("AGENT_MESSENGER_")) delete env[k];
  // a broker saved with set_broker(persist) on this machine must never steer a test: point at a file that does not exist
  env.AGENT_MESSENGER_CLIENT_STATE = join(tmpdir(), `am-test-no-client-state-${process.pid}.json`);
  return env;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function startBroker(env: Record<string, string | undefined>): Promise<ChildProcess> {
  const p = spawn(process.execPath, [BROKER_BIN], { env, stdio: ["ignore", "ignore", "pipe"] });
  p.stderr!.on("data", () => {});
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${env.AGENT_MESSENGER_PORT}/health`);
      if (r.ok) return p;
    } catch {
      // not yet
    }
    await sleep(100);
  }
  p.kill();
  throw new Error("broker did not start");
}

export function clientCommand(): { command: string; args: string[] } {
  const bin = process.env.AGENT_MESSENGER_CLIENT_BIN;
  if (bin) return { command: bin, args: [] };
  return { command: process.execPath, args: [CLIENT_MAIN] };
}

export interface JsonRpcNotification {
  method: string;
  params: unknown;
}

export interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

/** Minimal MCP stdio client (newline-delimited JSON-RPC 2.0). */
export class McpTestClient {
  readonly proc: ChildProcess;
  readonly notifications: JsonRpcNotification[] = [];
  readonly stderr: string[] = [];
  readonly exited: Promise<number | null>;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buf = "";

  constructor(env: Record<string, string | undefined>) {
    const { command, args } = clientCommand();
    this.proc = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (chunk: string) => {
      this.buf += chunk;
      let i: number;
      while ((i = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        this.onLine(line);
      }
    });
    this.proc.stderr!.setEncoding("utf8");
    this.proc.stderr!.on("data", (d: string) => this.stderr.push(d));
    this.exited = new Promise((resolve) => this.proc.on("exit", (code) => resolve(code)));
  }

  private onLine(line: string) {
    const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { code: number; message: string }; method?: string; params?: unknown };
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === "string") this.notifications.push({ method: msg.method, params: msg.params });
  }

  writeRaw(line: string) {
    this.proc.stdin!.write(line + "\n");
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.writeRaw(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  notify(method: string, params?: unknown) {
    this.writeRaw(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  async initialize(protocolVersion = "2025-06-18") {
    const r = await this.request("initialize", {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    this.notify("notifications/initialized");
    return r;
  }

  callTool(name: string, args?: Record<string, unknown>): Promise<ToolResult> {
    return this.request<ToolResult>("tools/call", { name, arguments: args });
  }

  /** Wait until `pred()` holds or `ms` elapsed. */
  async waitFor(pred: () => boolean, ms = 5000): Promise<boolean> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (pred()) return true;
      await sleep(100);
    }
    return pred();
  }

  stderrText() {
    return this.stderr.join("");
  }

  /** Close stdin (the client unregisters and exits); kill if it does not exit in time. */
  async close(): Promise<number | null> {
    this.proc.stdin!.end();
    const code = await Promise.race([this.exited, sleep(5000).then(() => "timeout" as const)]);
    if (code === "timeout") {
      this.proc.kill("SIGKILL");
      return this.exited;
    }
    return code;
  }
}

/** Start a client and wait for its startup log lines (registration) or exit. */
export async function startClientProcess(env: Record<string, string | undefined>): Promise<McpTestClient> {
  const c = new McpTestClient(env);
  await c.waitFor(() => /Registered as peer|MCP connected/.test(c.stderrText()), 15000);
  return c;
}
