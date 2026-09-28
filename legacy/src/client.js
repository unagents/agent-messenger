import { TOKEN } from "./config.js";

let brokerUrl = "";

/** Set once the broker has been resolved (see resolve.js). */
export function setBrokerUrl(url) {
  brokerUrl = url.replace(/\/$/, "");
}

export function getBrokerUrl() {
  return brokerUrl;
}

/**
 * POST JSON to the broker. Throws on non-2xx.
 */
export async function brokerFetch(path, body, opts = {}) {
  const url = opts.url ?? brokerUrl;
  if (!url) throw new Error("broker not resolved");
  const token = opts.token ?? TOKEN;
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${text}`);
  }
  return res.json();
}

export async function brokerHealth(url = brokerUrl, timeoutMs = 2000) {
  if (!url) return null;
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
