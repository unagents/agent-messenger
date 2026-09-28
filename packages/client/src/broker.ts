import { connect as netConnect } from "node:net";
import type { BrokerPostRoute, BrokerRequest, BrokerResponse, HealthResponse } from "@agent-hand/messenger-protocol";
import { HEALTH_ROUTE } from "./constants.js";

/**
 * Broker HTTP client (same behaviour as the current `src/client.js`).
 *
 * Transport: a minimal HTTP/1.1 client over `node:net` (`Connection: close`).
 * `node:http` is not usable in the PerryTS native build, and PerryTS's `fetch`
 * drops every request header (so the `Authorization: Bearer` token could not be
 * sent) — see `reports/20260928-ts-03-client.md`. The same code path is used
 * under node.
 */
export interface BrokerClient {
  setUrl(url: string): void;
  getUrl(): string;
  /** POST JSON to the broker. Throws on non-2xx. */
  post<R extends BrokerPostRoute>(path: R, body: BrokerRequest<R>, opts?: { timeoutMs?: number }): Promise<BrokerResponse<R>>;
  /** GET /health; `null` when unreachable or non-2xx. */
  health(url?: string, timeoutMs?: number): Promise<HealthResponse | null>;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  body: string;
}

/** One HTTP/1.1 request over a fresh TCP connection. Rejects on connection error or timeout. */
export function httpRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number
): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    if (u.protocol !== "http:") {
      reject(new Error(`unsupported protocol: ${u.protocol}`));
      return;
    }
    const host = u.hostname;
    const port = u.port ? Number(u.port) : 80;
    const path = `${u.pathname}${u.search}`;
    const chunks: Buffer[] = [];
    let settled = false;
    const sock = netConnect(port, host);
    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        sock.destroy();
        reject(err);
        return;
      }
      try {
        resolve(parseResponse(Buffer.concat(chunks)));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    const timer = setTimeout(() => finish(new Error(`request timeout after ${timeoutMs}ms`)), timeoutMs);
    sock.on("connect", () => {
      const lines = [
        `${method} ${path} HTTP/1.1`,
        `Host: ${host}:${port}`,
        "Connection: close",
        `Content-Length: ${Buffer.byteLength(body)}`,
      ];
      for (const k of Object.keys(headers)) lines.push(`${k}: ${headers[k]}`);
      sock.write(lines.join("\r\n") + "\r\n\r\n" + body);
    });
    sock.on("data", (d: Buffer) => {
      chunks.push(d);
    });
    sock.on("error", (e: Error) => finish(e));
    sock.on("close", () => finish(null));
  });
}

/** Parse status line + headers; body by Content-Length, chunked encoding, or read-to-close. */
function parseResponse(raw: Buffer): HttpResponse {
  const sep = raw.indexOf("\r\n\r\n");
  if (sep === -1) throw new Error("malformed HTTP response (no header terminator)");
  const head = raw.subarray(0, sep).toString("utf8");
  const headLines = head.split("\r\n");
  const status = Number(headLines[0].split(" ")[1]);
  if (!Number.isFinite(status)) throw new Error(`malformed HTTP status line: ${headLines[0]}`);
  const h: Record<string, string> = {};
  for (let i = 1; i < headLines.length; i++) {
    const c = headLines[i].indexOf(":");
    if (c === -1) continue;
    h[headLines[i].slice(0, c).trim().toLowerCase()] = headLines[i].slice(c + 1).trim();
  }
  let bodyBuf = raw.subarray(sep + 4);
  if ((h["transfer-encoding"] ?? "").toLowerCase() === "chunked") {
    bodyBuf = dechunk(bodyBuf);
  } else if (h["content-length"] !== undefined) {
    bodyBuf = bodyBuf.subarray(0, Number(h["content-length"]));
  }
  return { status, ok: status >= 200 && status < 300, body: bodyBuf.toString("utf8") };
}

function dechunk(buf: Buffer): Buffer {
  const out: Buffer[] = [];
  let pos = 0;
  for (;;) {
    const eol = buf.indexOf("\r\n", pos);
    if (eol === -1) break;
    const size = parseInt(buf.subarray(pos, eol).toString("ascii").split(";")[0], 16);
    if (!Number.isFinite(size) || size === 0) break;
    out.push(buf.subarray(eol + 2, eol + 2 + size));
    pos = eol + 2 + size + 2;
  }
  return Buffer.concat(out);
}

export function createBrokerClient(token: string): BrokerClient {
  let brokerUrl = "";
  return {
    setUrl(url: string) {
      brokerUrl = url.replace(/\/$/, "");
    },
    getUrl() {
      return brokerUrl;
    },
    async post(path, body, opts = {}) {
      if (!brokerUrl) throw new Error("broker not resolved");
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await httpRequest("POST", `${brokerUrl}${path}`, headers, JSON.stringify(body ?? {}), opts.timeoutMs ?? 5000);
      if (!res.ok) {
        throw new Error(`Broker error (${path}): ${res.status} ${res.body}`);
      }
      return JSON.parse(res.body) as never;
    },
    async health(url = brokerUrl, timeoutMs = 2000) {
      if (!url) return null;
      try {
        const res = await httpRequest("GET", `${url}${HEALTH_ROUTE}`, {}, "", timeoutMs);
        if (!res.ok) return null;
        return JSON.parse(res.body) as HealthResponse;
      } catch {
        return null;
      }
    },
  };
}
