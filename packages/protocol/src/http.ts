/**
 * Broker HTTP API — request / response JSON shapes.
 *
 * Transcribed from `legacy/src/broker.js` (handlers) and `legacy/src/server.js` /
 * `legacy/bin/agent-messenger.js` (callers). Field optionality follows the broker:
 * a field the broker defaults with `??` is optional here.
 *
 * Transport rules (from `legacy/src/broker.js` `startBroker`):
 * - `GET /health` is the only GET route.
 * - Every other route is `POST` with a JSON body; empty body is treated as `{}`.
 * - When the broker has a token, each POST must send `Authorization: Bearer <token>`,
 *   otherwise `401 {"error":"unauthorized"}`.
 * - Unknown POST path: `404 {"error":"not found"}`. Handler exception: `500 {"error":<message>}`.
 * - Any other method: `200 text/plain` `agent-messenger broker <version>\n`.
 */

/** A registered session as stored and returned by the broker. */
export interface Peer {
  /** 8-char broker-generated id (`[a-z0-9]`). */
  id: string;
  /** Stable name set via `/register` or `/set-name`; `""` when unset. */
  name: string;
  /** Client process id. */
  pid: number;
  hostname: string;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  /** ISO 8601 timestamp. */
  registered_at: string;
  /** ISO 8601 timestamp; refreshed by `/heartbeat`. */
  last_seen: string;
}

export type MessageMode = "pull" | "push" | "ping";

/** A message as stored and returned by the broker. */
export interface Message {
  /** Broker-assigned incrementing integer. */
  id: number;
  /** Sender peer id, or `"cli"` when sent from the CLI. */
  from_id: string;
  from_name: string;
  to_id: string;
  text: string;
  /**
   * How the receiver shows it: `"pull"` = unread notice only, text via
   * `check_messages`; `"push"` = text shown directly; `"ping"` = liveness
   * notice, no text. Missing (older broker / sender) means `"pull"`.
   */
  mode?: MessageMode;
  /** ISO 8601 timestamp. */
  sent_at: string;
  /** 0 until returned by `/poll-messages`, then 1. */
  delivered: 0 | 1;
  /** Always 0 in the current implementation (acknowledged messages are deleted). */
  acknowledged: 0 | 1;
}

/** `/list-peers` scope filter. Unknown values behave as `"all"`. */
export type PeerScope = "all" | "host" | "directory" | "repo";

/** Generic `{ok:true}` / `{ok:false,error}` result. */
export type OkResult = { ok: true } | { ok: false; error: string };

/** Body of a non-2xx broker response. */
export interface BrokerErrorResponse {
  error: string;
}

// --- GET /health ---

export interface HealthResponse {
  status: "ok";
  /** Broker package version. */
  version: string;
  /** Broker id (`AGENT_MESSENGER_BROKER_ID`, default hostname). */
  id: string;
  /** Broker HTTP port. */
  port: number;
  /** Count of peers seen within `HEARTBEAT_TIMEOUT_MS`. */
  peers: number;
}

// --- POST /register ---

export interface RegisterRequest {
  pid: number;
  hostname?: string;
  cwd?: string;
  git_root?: string | null;
  tty?: string | null;
  summary?: string;
  name?: string;
}

export interface RegisterResponse {
  id: string;
}

// --- POST /heartbeat ---

export interface HeartbeatRequest {
  id: string;
}

/** `ok:false` with `"unknown peer (re-register)"` when the broker does not know the id. */
export type HeartbeatResponse = OkResult;

// --- POST /set-summary ---

export interface SetSummaryRequest {
  id: string;
  summary?: string;
}

export type SetSummaryResponse = OkResult;

// --- POST /set-name ---

export interface SetNameRequest {
  id: string;
  name?: string;
}

export type SetNameResponse = OkResult;

// --- POST /list-peers ---

export interface ListPeersRequest {
  scope?: PeerScope;
  /** Used by scope `"host"`. */
  hostname?: string;
  /** Used by scope `"directory"`, and by `"repo"` when `git_root` is empty. */
  cwd?: string;
  /** Used by scope `"repo"`. */
  git_root?: string | null;
  /** Peer id to omit from the result (the caller itself). */
  exclude_id?: string;
}

export type ListPeersResponse = Peer[];

// --- POST /send-message ---

export interface SendMessageRequest {
  /** Target peer id or unique peer name. */
  to: string;
  /** Defaults to `"cli"`. */
  from_id?: string;
  from_name?: string;
  text?: string;
  /** Defaults to `"pull"`. Unknown values are rejected. */
  mode?: MessageMode;
}

export type SendMessageResponse =
  | { ok: true; to_id: string; to_name: string; message_id: number }
  | { ok: false; error: string };

// --- POST /poll-messages ---

export interface PollMessagesRequest {
  id: string;
}

/** Undelivered messages for `id`; each is marked `delivered: 1` on return. */
export interface PollMessagesResponse {
  messages: Message[];
}

// --- POST /acknowledge-messages ---

export interface AcknowledgeMessagesRequest {
  id: string;
  message_ids?: number[];
}

export type AcknowledgeMessagesResponse = { ok: true };

// --- POST /get-buffered-messages ---

export interface GetBufferedMessagesRequest {
  id: string;
}

/** Messages for `id` with `delivered: 1` and `acknowledged: 0`. */
export interface GetBufferedMessagesResponse {
  messages: Message[];
}

// --- POST /unregister ---

export interface UnregisterRequest {
  id: string;
}

export type UnregisterResponse = { ok: true };

// --- Route table ---

/** The only GET route. */
export const HEALTH_ROUTE = "/health" as const;

/** POST routes, in the order of `ROUTES` in `legacy/src/broker.js`. */
export const BROKER_POST_ROUTES = [
  "/register",
  "/heartbeat",
  "/set-summary",
  "/set-name",
  "/list-peers",
  "/send-message",
  "/poll-messages",
  "/acknowledge-messages",
  "/get-buffered-messages",
  "/unregister",
] as const;

export type BrokerPostRoute = (typeof BROKER_POST_ROUTES)[number];

/** Request / response pair per POST route. */
export interface BrokerRouteMap {
  "/register": { request: RegisterRequest; response: RegisterResponse };
  "/heartbeat": { request: HeartbeatRequest; response: HeartbeatResponse };
  "/set-summary": { request: SetSummaryRequest; response: SetSummaryResponse };
  "/set-name": { request: SetNameRequest; response: SetNameResponse };
  "/list-peers": { request: ListPeersRequest; response: ListPeersResponse };
  "/send-message": { request: SendMessageRequest; response: SendMessageResponse };
  "/poll-messages": { request: PollMessagesRequest; response: PollMessagesResponse };
  "/acknowledge-messages": { request: AcknowledgeMessagesRequest; response: AcknowledgeMessagesResponse };
  "/get-buffered-messages": { request: GetBufferedMessagesRequest; response: GetBufferedMessagesResponse };
  "/unregister": { request: UnregisterRequest; response: UnregisterResponse };
}

export type BrokerRequest<R extends BrokerPostRoute> = BrokerRouteMap[R]["request"];
export type BrokerResponse<R extends BrokerPostRoute> = BrokerRouteMap[R]["response"];
