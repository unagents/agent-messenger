/**
 * Issue #2: `send_message` called with `{to, text}` (no `message`) was treated as a success and the
 * broker queued a message whose body was the string "undefined". A tools/call whose arguments break
 * the tool's inputSchema must come back as an error and must not reach the broker.
 */
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { baseEnv, startBroker, startClientProcess } from "./helpers.js";

const PORT = 18901 + Math.floor(Math.random() * 1000);
const TOKEN = "test-token";
const dir = mkdtempSync(join(tmpdir(), "am-client-args-"));

const env = {
  ...baseEnv(),
  AGENT_MESSENGER_HOST: "127.0.0.1",
  AGENT_MESSENGER_PORT: String(PORT),
  AGENT_MESSENGER_BIND: "127.0.0.1",
  AGENT_MESSENGER_TOKEN: TOKEN,
  AGENT_MESSENGER_STATE: join(dir, "broker.json"),
  AGENT_MESSENGER_DISCOVERY: "off",
  AGENT_MESSENGER_CONFIG: join(dir, "no-config.json"),
};

let broker: ChildProcess;

async function post<T = any>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T>;
}

beforeAll(async () => {
  broker = await startBroker(env);
});

afterAll(async () => {
  await new Promise<void>((r) => {
    broker.once("exit", () => r());
    broker.kill("SIGTERM");
  });
  rmSync(dir, { recursive: true, force: true });
});

describe("send_message with the body under the wrong argument name (issue #2)", () => {
  it("returns isError and names the missing argument and the received ones", async () => {
    const rx = await post<{ id: string }>("/register", { pid: process.pid, hostname: "rx-host", cwd: "/rx", name: "rx-a" });
    const c = await startClientProcess({ ...env, AGENT_MESSENGER_NAME: "tx-a" });
    try {
      await c.initialize();
      const r = await c.callTool("send_message", { to: "rx-a", text: "hello", delivery: "pull" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toBe('missing required argument "message" (got: to, text, delivery)');
    } finally {
      await c.close();
      await post("/unregister", { id: rx.id });
    }
  });

  it("queues nothing at the broker", async () => {
    const rx = await post<{ id: string }>("/register", { pid: process.pid, hostname: "rx-host", cwd: "/rx", name: "rx-b" });
    const c = await startClientProcess({ ...env, AGENT_MESSENGER_NAME: "tx-b" });
    try {
      await c.initialize();
      await c.callTool("send_message", { to: "rx-b", text: "hello", delivery: "pull" });
      const polled = await post<{ messages: { text: string }[] }>("/poll-messages", { id: rx.id });
      expect(polled.messages).toEqual([]);
    } finally {
      await c.close();
      await post("/unregister", { id: rx.id });
    }
  });
});
