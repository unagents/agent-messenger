import {
  createApp,
  createRouter,
  defineEventHandler,
  getRequestHeader,
  readRawBody,
  send,
  setResponseStatus,
  type App,
  type H3Event,
} from "h3";
import type { BrokerErrorResponse, BrokerPostRoute, HealthResponse, ProtocolRoute, RelayMessagesRequest } from "@unagents/messenger-protocol";
import { BROKER_POST_ROUTES, HEALTH_ROUTE, MESH_SYNC_ROUTE, PROTOCOL_ROUTES, RELAY_ROUTE } from "@unagents/messenger-protocol";
import type { BrokerHandlers } from "./handlers.js";

export interface HttpAppOptions {
  handlers: BrokerHandlers;
  version: string;
  id: string;
  /** Reported in `/health`; the port the server actually listens on. */
  port: () => number;
  token: string;
  /** Reported in `/health` (as `fallback: true`) when the broker is a local fallback. */
  fallback?: boolean;
  /** Answer `POST /mesh/sync`; when false the route does not exist (404), like on a 0.6.x broker. */
  mesh?: boolean;
}

/**
 * Build the h3 app. Transport rules are those of `legacy/src/broker.js`:
 *
 * - `GET /health` → `{status, version, id, port, peers}`
 * - any other non-POST → `200 text/plain "agent-messenger broker <version>\n"`
 * - POST without a matching bearer token (when one is set) → `401 {error:"unauthorized"}`
 * - POST to an unknown path → `404 {error:"not found"}`
 * - empty body = `{}`; invalid JSON or a throwing handler → `500 {error:<message>}`
 */
export function createBrokerApp(opts: HttpAppOptions): App {
  const routes = opts.handlers.routes();
  const protocolRoutes = opts.handlers.protocolRoutes();
  const router = createRouter();

  router.get(HEALTH_ROUTE, defineEventHandler((): HealthResponse => ({
    status: "ok",
    version: opts.version,
    id: opts.id,
    port: opts.port(),
    peers: opts.handlers.alivePeerCount(),
    ...(opts.fallback ? { fallback: true as const } : {}),
    ...(opts.mesh ? { mesh: true as const } : {}),
  })));

  const post = (route: string, run: (body: unknown) => unknown) =>
    router.post(route, defineEventHandler(async (event) => {
      if (!authorized(event, opts.token)) return unauthorized(event);
      try {
        return run(await readJson(event));
      } catch (e) {
        setResponseStatus(event, 500);
        return { error: (e as Error).message } satisfies BrokerErrorResponse;
      }
    }));

  for (const route of BROKER_POST_ROUTES) post(route, (body) => routes[route as BrokerPostRoute](body as never));
  post(RELAY_ROUTE, (body) => opts.handlers.relayMessages(body as RelayMessagesRequest));
  for (const route of PROTOCOL_ROUTES) post(route, (body) => protocolRoutes[route as ProtocolRoute](body as never));

  if (opts.mesh) post(MESH_SYNC_ROUTE, (body) => opts.handlers.meshSync(body as never));

  const app = createApp();
  app.use(router);
  // fallback: non-POST banner, or POST to an unknown path
  app.use(defineEventHandler(async (event) => {
    if (event.method !== "POST") {
      return send(event, `agent-messenger broker ${opts.version}\n`, "text/plain");
    }
    if (!authorized(event, opts.token)) return unauthorized(event);
    setResponseStatus(event, 404);
    return { error: "not found" } satisfies BrokerErrorResponse;
  }));
  return app;
}

function authorized(event: H3Event, token: string): boolean {
  return !token || getRequestHeader(event, "authorization") === `Bearer ${token}`;
}

function unauthorized(event: H3Event): BrokerErrorResponse {
  setResponseStatus(event, 401);
  return { error: "unauthorized" };
}

/** Same semantics as `readJson` in `legacy/src/broker.js`: empty body → `{}`, bad JSON → throws. */
async function readJson(event: H3Event): Promise<unknown> {
  const raw = await readRawBody(event, "utf8");
  return raw ? JSON.parse(raw) : {};
}
