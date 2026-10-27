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

import type { ProtocolErrorCode } from "./constants.js";

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
  /**
   * Mesh only: id of the permanent broker this peer is registered with, set on
   * copies a mesh broker replicated from another one. Absent for peers that
   * registered directly. Never returned by `/list-peers`.
   */
  origin?: string;
  /**
   * Protocols this peer serves (`/set-protocol`, re-sent on `/register` and `/heartbeat`). Hash only; the
   * definition body lives in the broker's protocol store. Absent when none (and from 0.9.x brokers).
   */
  protocols?: ProtocolDecl[];
}

/** A protocol a peer declares: identity (`name` + `version`) and the hash of its definition body. */
export interface ProtocolDecl {
  /** `^[a-z0-9][a-z0-9._-]{0,63}$` (`PROTOCOL_NAME_PATTERN`). */
  name: string;
  /** semver, or `0.0.0+<sha7>` for a repo without tags. */
  version: string;
  /** `sha256(canonicalJSON({manifest, doc}))` as lower-case hex. */
  hash: string;
}

/** The definition body a server fetched from its protocol repo. */
export interface ProtocolDefinition {
  /** Parsed `protocol.json`. */
  manifest: object;
  /** `PROTOCOL.md` text; `""` when the repo has none. */
  doc: string;
  /** Normalized repo notation (`github:o/r`, `gitea:<base>/o/r`, `file:<abs path>`). Not part of the hash. */
  source: string;
  /** tag or sha the body was read at (`local` for a local path). Not part of the hash. */
  ref: string;
}

/** What the broker keeps per `(name, version)`. */
export interface StoredProtocol extends ProtocolDecl {
  definition: ProtocolDefinition;
  /** ISO 8601 timestamp of the first successful `/set-protocol` for this `(name, version)`. */
  registered_at: string;
}

/** Protocol tag of a message: which protocol (and version) the sender spoke. Both fields are required when present. */
export interface MessageMeta {
  protocol: string;
  version: string;
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
   * notice; `text` is its optional subject (e.g. a task id), `""` when none. Missing (older broker / sender) means `"pull"`.
   */
  mode?: MessageMode;
  /** ISO 8601 timestamp. */
  sent_at: string;
  /** 0 until returned by `/poll-messages`, then 1. */
  delivered: 0 | 1;
  /** Always 0 in the current implementation (acknowledged messages are deleted). */
  acknowledged: 0 | 1;
  /** Mesh only: `<sender broker id>:<id there>` of a message forwarded by another broker (duplicate guard). */
  mesh_key?: string;
  /** Protocol tag given to `/send-message`; returned by `/poll-messages` and kept across relay / mesh forwarding. */
  meta?: MessageMeta;
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
  /** Present (`true`) only when the broker was started as a local fallback (`AGENT_MESSENGER_FALLBACK=1`). */
  fallback?: true;
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
  /** Protocols to declare right away (hash only; bodies follow via `/set-protocol`). */
  protocols?: ProtocolDecl[];
}

export interface RegisterResponse {
  id: string;
}

// --- POST /heartbeat ---

export interface HeartbeatRequest {
  id: string;
  /** Every protocol the peer currently serves (hash only), sent on each heartbeat. */
  protocols?: ProtocolDecl[];
}

/**
 * `ok:false` with `"unknown peer (re-register)"` when the broker does not know the id.
 * `resend` lists the `"name@version"` of declared protocols whose body the broker does not hold; the client answers
 * with `/set-protocol`. Absent when nothing is missing (and from 0.9.x brokers).
 */
export type HeartbeatResponse = { ok: true; resend?: string[] } | { ok: false; error: string };

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
  /** Only peers that declare this protocol (AND with `scope`). */
  protocol?: string;
  /** Only with `protocol`: only peers that declare exactly this version. */
  version?: string;
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
  /** Protocol tag. Both fields must be strings of at most `PROTOCOL_META_MAX_LENGTH` characters. */
  meta?: MessageMeta;
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

// --- POST /relay-messages (fallback broker -> permanent broker; not part of the legacy route table) ---

/** One undelivered message handed over by a fallback broker. The recipient is addressed by name: peer ids are broker-local. */
export interface RelayedMessage {
  from_id: string;
  from_name: string;
  /** Recipient peer name on the sending broker. Items without a name cannot be relayed. */
  to_name: string;
  /** Recipient hostname on the sending broker; narrows ambiguous names. */
  to_hostname?: string;
  text: string;
  mode?: MessageMode;
  sent_at: string;
  meta?: MessageMeta;
}

export interface RelayMessagesRequest {
  messages: RelayedMessage[];
}

/** `delivered` = queued for a registered peer, `queued` = held until a peer of that name registers, `dropped` = no usable name. */
export interface RelayMessagesResponse {
  ok: true;
  delivered: number;
  queued: number;
  dropped: number;
}

/** Extra POST route served by the TypeScript broker. Not in `BROKER_POST_ROUTES` (that table mirrors the legacy broker). */
export const RELAY_ROUTE = "/relay-messages" as const;

// --- Protocol registry routes (not part of BROKER_POST_ROUTES; route names are `PROTOCOL_ROUTES` in constants) ---

/** `{ok:false}` answer of the protocol routes; `code` is one of `PROTOCOL_ERROR_CODES`. */
export interface ProtocolErrorResponse {
  ok: false;
  error: string;
  code: ProtocolErrorCode;
  /** `PROTOCOL_CONFLICT`: hash the broker already holds for this `(name, version)`. */
  existing_hash?: string;
  /** `PROTOCOL_CONFLICT`: servers (`name@host`) that hold it. */
  servers?: string[];
  /** `PROTOCOL_NOT_FOUND`: versions the broker does hold for the name (may be empty). */
  versions?: string[];
}

// --- POST /set-protocol ---

export interface SetProtocolRequest {
  /** Peer id of the server. */
  id: string;
  name: string;
  version: string;
  /** Re-computed by the broker; a different value is `HASH_MISMATCH`. */
  hash: string;
  definition: ProtocolDefinition;
}

/** `{ok:false, error}` without `code` only for an unknown peer id. */
export type SetProtocolResponse = { ok: true } | ProtocolErrorResponse | { ok: false; error: string };

// --- POST /unset-protocol ---

export interface UnsetProtocolRequest {
  id: string;
  /** Protocol to drop; all declarations of the peer when omitted. */
  name?: string;
}

export type UnsetProtocolResponse = { ok: true; removed: number } | { ok: false; error: string };

// --- POST /get-protocol ---

export interface GetProtocolRequest {
  name: string;
  /** Highest version the broker holds when omitted (`0.0.0+sha` counts as lowest). */
  version?: string;
}

/** `servers` = number of alive peers (replicas included) that declare the returned protocol. */
export type GetProtocolResponse = { ok: true; protocol: StoredProtocol; servers: number } | ProtocolErrorResponse;

/** Request / response pair per protocol route. */
export interface ProtocolRouteMap {
  "/set-protocol": { request: SetProtocolRequest; response: SetProtocolResponse };
  "/unset-protocol": { request: UnsetProtocolRequest; response: UnsetProtocolResponse };
  "/get-protocol": { request: GetProtocolRequest; response: GetProtocolResponse };
}

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

// --- Broker mesh (permanent brokers only; not part of BROKER_POST_ROUTES) ---

/** Broker-to-broker sync route. Old brokers answer 404 and are simply not part of the mesh. */
export const MESH_SYNC_ROUTE = "/mesh/sync" as const;

/**
 * POST /mesh/sync — one round of peer / message replication, sent by each
 * mesh broker to every other one.
 */
export interface MeshSyncRequest {
  /** Id of the sending broker (= `origin` of the peers below). */
  from: string;
  /** Live peers that registered directly with the sender (replaces what the receiver holds for `from`). */
  peers: Peer[];
  /** Undelivered messages the sender holds for peers that live on the receiver. Ids are the sender's. */
  messages: Message[];
  /** Definitions declared by the sender's direct peers. Absent from 0.9.x brokers. */
  protocols?: StoredProtocol[];
}

export interface MeshSyncResponse {
  /** Id of the receiving broker. */
  id: string;
  /** Live peers that registered directly with the receiver. */
  peers: Peer[];
  /** Sender-side ids of the messages the receiver took over; the sender drops them. */
  accepted: number[];
  /** Definitions declared by the receiver's direct peers. Absent from 0.9.x brokers. */
  protocols?: StoredProtocol[];
}
