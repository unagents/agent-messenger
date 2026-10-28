/**
 * The client keeps its own copy of the protocol's runtime constants (see
 * src/constants.ts for why). This test pins them to the protocol package.
 */
import * as protocol from "@unagents/messenger-protocol";
import { describe, expect, it } from "vitest";
import * as local from "../src/constants.js";

describe("client constants match @unagents/messenger-protocol", () => {
  it("numbers", () => {
    expect(local.DEFAULT_HTTP_PORT).toBe(protocol.DEFAULT_HTTP_PORT);
    expect(local.DEFAULT_DISCOVERY_PORT).toBe(protocol.DEFAULT_DISCOVERY_PORT);
    expect(local.DEFAULT_DISCOVERY_TIMEOUT_MS).toBe(protocol.DEFAULT_DISCOVERY_TIMEOUT_MS);
    expect(local.HEARTBEAT_INTERVAL_MS).toBe(protocol.HEARTBEAT_INTERVAL_MS);
    expect(local.POLL_INTERVAL_MS).toBe(protocol.POLL_INTERVAL_MS);
  });

  it("strings and tables", () => {
    expect(local.LOCAL_HOSTS).toEqual([...protocol.LOCAL_HOSTS]);
    expect(local.ENV).toEqual(protocol.ENV);
    expect(local.SESSION_SOCKET_ENV).toBe(protocol.SESSION_SOCKET_ENV);
    expect(local.SESSION_TOKEN_ENV).toBe(protocol.SESSION_TOKEN_ENV);
    expect(local.HEALTH_ROUTE).toBe(protocol.HEALTH_ROUTE);
    expect(local.DISCOVERY_KEY).toBe(protocol.DISCOVERY_KEY);
    expect(local.DISCOVERY_PROBE_VALUE).toBe(protocol.DISCOVERY_PROBE_VALUE);
    expect(local.DISCOVERY_REPLY_VALUE).toBe(protocol.DISCOVERY_REPLY_VALUE);
    expect(local.DISCOVERY_BROADCAST_ADDR).toBe(protocol.DISCOVERY_BROADCAST_ADDR);
    expect({ [local.DISCOVERY_KEY]: local.DISCOVERY_PROBE_VALUE }).toEqual(protocol.DISCOVERY_PROBE);
  });
});

describe("broker autonomy constants (0.11.0)", () => {
  it("env names match the protocol package", () => {
    expect(local.DISCOVERY_TARGETS_ENV).toBe(protocol.DISCOVERY_TARGETS_ENV);
    expect(local.CLIENT_STATE_ENV).toBe(protocol.CLIENT_STATE_ENV);
  });
});
