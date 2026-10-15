import type { RelayedMessage, RelayMessagesResponse, SendMessageResponse } from "@agent-hand/messenger-protocol";
import { RELAY_ROUTE } from "@agent-hand/messenger-protocol";
import { log } from "./log.js";
import type { BrokerState } from "./state.js";

const TIMEOUT_MS = 5000;

async function post(url: string, path: string, token: string, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${url}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/**
 * Hand the undelivered messages of `state` to the broker at `url`, then drop them locally.
 * Throws (state untouched) when the target cannot be reached, so the caller retries later.
 *
 * Recipients are sent by name: peer ids are broker-local. A message whose recipient has no name cannot
 * be addressed on another broker and is dropped (counted in the result).
 * A target without `/relay-messages` (older broker, 404) gets `/send-message` by name instead, which
 * only reaches peers that are already registered there.
 */
export async function relayUndelivered(
  state: BrokerState,
  url: string,
  token: string
): Promise<{ sent: number; dropped: number }> {
  const items: RelayedMessage[] = [];
  let dropped = 0;
  for (const m of state.messages) {
    if (m.delivered !== 0) continue;
    const peer = state.peers.get(m.to_id);
    if (!peer?.name) {
      dropped++;
      continue;
    }
    items.push({
      from_id: m.from_id,
      from_name: m.from_name,
      to_name: peer.name,
      to_hostname: peer.hostname,
      text: m.text,
      mode: m.mode ?? "pull",
      sent_at: m.sent_at,
    });
  }

  let sent = 0;
  if (items.length) {
    const res = await post(url, RELAY_ROUTE, token, { messages: items });
    if (res.ok) {
      const r = (await res.json()) as RelayMessagesResponse;
      sent = r.delivered + r.queued;
      dropped += r.dropped;
    } else if (res.status === 404) {
      for (const it of items) {
        const r = await post(url, "/send-message", token, { to: it.to_name, from_id: it.from_id, from_name: it.from_name, text: it.text, mode: it.mode });
        if (r.ok && ((await r.json()) as SendMessageResponse).ok) sent++;
        else dropped++;
      }
    } else {
      throw new Error(`relay to ${url} failed: ${res.status} ${await res.text()}`);
    }
  }
  state.messages = state.messages.filter((m) => m.delivered !== 0);
  state.scheduleSave();
  log.info(`relayed ${sent} message(s) to ${url} (${dropped} dropped: recipient without name or refused)`);
  return { sent, dropped };
}
