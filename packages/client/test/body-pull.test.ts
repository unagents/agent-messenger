/**
 * send_message delivery "pull" (default): the session receives only an unread
 * notice line (no message text); the text stays at the broker until
 * check_messages. send_ping: a one-line ping notice, never in check_messages.
 */
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { baseEnv, sleep, startBroker, startClientProcess } from "./helpers.js";

const PORT = 18901 + Math.floor(Math.random() * 1000);
const TOKEN = "test-token";
const dir = mkdtempSync(join(tmpdir(), "am-client-pull-"));

const env = {
  ...baseEnv(),
  AGENT_MESSENGER_HOST: "127.0.0.1",
  AGENT_MESSENGER_PORT: String(PORT),
  AGENT_MESSENGER_BIND: "127.0.0.1",
  AGENT_MESSENGER_TOKEN: TOKEN,
  AGENT_MESSENGER_STATE: join(dir, "broker.json"),
  AGENT_MESSENGER_DISCOVERY: "off",
};

let broker: ChildProcess;

/** unix socket server standing in for the Claude Code session inbox; collects posted lines */
function sessionInbox(sockPath: string): Promise<{ server: Server; lines: any[] }> {
  const lines: any[] = [];
  const server = createServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\n")) !== -1) {
        lines.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
    c.on("end", () => c.end());
  });
  return new Promise((r) => server.listen(sockPath, () => r({ server, lines })));
}

beforeAll(async () => {
  broker = await startBroker(env);
});

afterAll(async () => {
  // wait for the broker to flush its state file before removing the directory
  await new Promise<void>((r) => {
    broker.once("exit", () => r());
    broker.kill("SIGTERM");
  });
  rmSync(dir, { recursive: true, force: true });
});

describe("delivery=pull (default) and send_ping", () => {
  it("session socket gets one unread notice per new message set; check_messages returns the text and stops the notices", async () => {
    const { server, lines } = await sessionInbox(join(dir, "session.sock"));
    const cap = await startClientProcess({
      ...env,
      AGENT_MESSENGER_NAME: "cap-pull",
      CLAUDE_CODE_MESSAGING_SOCKET: join(dir, "session.sock"),
      CLAUDE_CODE_MESSAGING_TOKEN: "tok",
    });
    await cap.initialize();
    const master = await startClientProcess({ ...env, AGENT_MESSENGER_NAME: "master-pull" });
    await master.initialize();

    // 1st message → exactly one notice line (auth + user), no text
    await master.callTool("send_message", { to: "cap-pull", message: "secret body one" });
    await cap.waitFor(() => lines.filter((l) => l.type === "user").length >= 1, 5000);
    const users = () => lines.filter((l) => l.type === "user").map((l) => l.message.content as string);
    expect(lines[0]).toEqual({ type: "auth", token: "tok" });
    expect(users()).toEqual([`[agent-messenger] 未読 1 件（from master-pull@${hostname()}）。check_messages で受信してください`]);
    expect(users()[0]).not.toMatch(/secret body/);
    expect(cap.notifications.length, "no channel push").toBe(0);

    // polls keep running but the same message does not produce another notice
    await sleep(2500);
    expect(users().length).toBe(1);

    // 2nd message → the notice is renewed with the unread total
    await master.callTool("send_message", { to: "cap-pull", message: "secret body two", delivery: "pull" });
    await cap.waitFor(() => users().length >= 2, 5000);
    expect(users()[1]).toBe(`[agent-messenger] 未読 2 件（from master-pull@${hostname()}）。check_messages で受信してください`);
    expect(users()[1]).not.toMatch(/secret body/);

    // check_messages returns both texts (not acknowledged before this call)
    const cm = await cap.callTool("check_messages", {});
    expect(cm.content[0].text).toMatch(/^2 message\(s\):\n\n/);
    expect(cm.content[0].text).toMatch(/From master-pull \(\w+\)@\S+ at .*:\nsecret body one\n\n---\n\nFrom master-pull \(\w+\)@\S+ at .*:\nsecret body two$/s);
    expect(cap.stderrText()).toMatch(/Session socket unread notice OK \(1\) from master-pull@/);
    expect(cap.stderrText()).toMatch(/Session socket unread notice OK \(2\) from master-pull@/);

    // afterwards polling stays quiet and nothing is left
    await sleep(2500);
    expect(users().length).toBe(2);
    const again = await cap.callTool("check_messages", {});
    expect(again.content[0].text).toMatch(/No new messages/);

    await cap.close();
    await master.close();
    server.close();
  });

  it("channel route: unread notice only, text via check_messages", async () => {
    const cap = await startClientProcess({ ...env, AGENT_MESSENGER_NAME: "cap-pull-ch" });
    await cap.initialize();
    const master = await startClientProcess({ ...env, AGENT_MESSENGER_NAME: "master-pull-ch" });
    await master.initialize();
    await master.callTool("send_message", { to: "cap-pull-ch", message: "channel secret" });
    await cap.waitFor(() => cap.notifications.length > 0, 5000);
    expect(cap.notifications.length).toBe(1);
    const params = cap.notifications[0].params as { content: string; meta: Record<string, string> };
    expect(params.content).toBe(`[agent-messenger] 未読 1 件（from master-pull-ch@${hostname()}）。check_messages で受信してください`);
    expect(params.meta.from_name).toBe("master-pull-ch");
    await sleep(2500);
    expect(cap.notifications.length).toBe(1);
    const cm = await cap.callTool("check_messages", {});
    expect(cm.content[0].text).toMatch(/^1 message\(s\):\n\nFrom master-pull-ch .*:\nchannel secret$/s);
    await cap.close();
    await master.close();
  });

  it("send_ping: one ping notice with the sender, acknowledged, not in check_messages", async () => {
    const { server, lines } = await sessionInbox(join(dir, "session-ping.sock"));
    const cap = await startClientProcess({
      ...env,
      AGENT_MESSENGER_NAME: "cap-ping",
      CLAUDE_CODE_MESSAGING_SOCKET: join(dir, "session-ping.sock"),
      CLAUDE_CODE_MESSAGING_TOKEN: "tok",
    });
    await cap.initialize();
    const worker = await startClientProcess({ ...env, AGENT_MESSENGER_NAME: "worker-ping" });
    await worker.initialize();

    const r = await worker.callTool("send_ping", { to: "cap-ping" });
    expect(r.content[0].text).toMatch(/^Ping sent to cap-ping/);
    const users = () => lines.filter((l) => l.type === "user").map((l) => l.message.content as string);
    await cap.waitFor(() => users().length >= 1, 5000);
    expect(users()).toEqual([`[agent-messenger] ping（from worker-ping@${hostname()}）`]);

    // no unread notice follows and nothing is left to read
    await sleep(2500);
    expect(users().length).toBe(1);
    const cm = await cap.callTool("check_messages", {});
    expect(cm.content[0].text).toMatch(/No new messages/);

    // a second ping with a subject shows it in the notice
    await worker.callTool("send_ping", { to: "cap-ping", subject: "task-42 crawl" });
    await cap.waitFor(() => users().length >= 2, 5000);
    expect(users()[1]).toBe(`[agent-messenger] ping（from worker-ping@${hostname()}）: task-42 crawl`);
    const cm2 = await cap.callTool("check_messages", {});
    expect(cm2.content[0].text).toMatch(/No new messages/);

    const bad = await worker.callTool("send_ping", { to: "nobody" });
    expect(bad.isError).toBe(true);

    await cap.close();
    await worker.close();
    server.close();
  });

  it("send_message rejects an unknown delivery", async () => {
    const a = await startClientProcess({ ...env, AGENT_MESSENGER_NAME: "deliv-a" });
    await a.initialize();
    const r = await a.callTool("send_message", { to: "deliv-a", message: "x", delivery: "loud" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Invalid delivery: loud/);
    await a.close();
  });
});
