/**
 * Argument validation of the tool registry (issue #2): driven by each tool's inputSchema, applied
 * before the handler. A failing call is an isError result and never reaches the broker.
 */
import { describe, expect, it } from "vitest";
import { createInbox } from "../src/inbox.js";
import { createPeerState } from "../src/peer.js";
import { TOOL_DEFS } from "../src/tools/defs.js";
import { createToolRegistry } from "../src/tools/registry.js";
import type { JsonPropertySchema } from "../src/tools/types.js";
import { validateArgs } from "../src/tools/validate.js";

function setup() {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const broker = {
    async post(path: string, body: Record<string, unknown>) {
      calls.push({ path, body });
      return { ok: true, to_id: "x", to_name: "x", message_id: 1, id: "x", messages: [], peers: [] };
    },
  };
  const peer = createPeerState({ name: "me", hostname: "h", cwd: "/w" });
  peer.id = "me-id";
  const inbox = createInbox({ broker: broker as never, peer, log: () => {} });
  const registry = createToolRegistry({ broker: broker as never, peer, inbox });
  return { registry, calls };
}

function sample(prop: JsonPropertySchema): unknown {
  if (prop.type === "boolean") return true;
  if (prop.type === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(prop.properties ?? {})) o[k] = "v";
    return o;
  }
  return prop.enum !== undefined ? prop.enum[0] : "v";
}

function validArgs(def: (typeof TOOL_DEFS)[number]): Record<string, unknown> {
  const a: Record<string, unknown> = {};
  for (const k of def.inputSchema.required ?? []) a[k] = sample(def.inputSchema.properties[k]);
  return a;
}

const text = (r: { content: { text: string }[] }) => r.content[0].text;

describe("every tool: required missing / wrong type / enum", () => {
  for (const def of TOOL_DEFS) {
    const props = def.inputSchema.properties;

    for (const key of def.inputSchema.required ?? []) {
      it(`${def.name}: missing required "${key}" is an error and posts nothing`, async () => {
        const { registry, calls } = setup();
        const args = validArgs(def);
        delete args[key];
        // a decoy so the call is not "unknown arguments only"
        args.text = "decoy";
        const r = await registry.call(def.name, args);
        expect(r.isError).toBe(true);
        expect(text(r)).toBe(`missing required argument "${key}" (got: ${Object.keys(args).join(", ")})`);
        expect(calls).toEqual([]);
      });
    }

    for (const [key, prop] of Object.entries(props)) {
      it(`${def.name}: "${key}" of the wrong type is an error and posts nothing`, async () => {
        const { registry, calls } = setup();
        if (prop.type === "object") return; // left to parseMeta (INVALID_META)
        const wrong = prop.type === "string" ? 123 : 7;
        const r = await registry.call(def.name, { ...validArgs(def), [key]: wrong });
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(new RegExp(`^argument "${key}" must be an? (string|boolean) \\(got number\\)$`));
        expect(calls).toEqual([]);
      });

      if (prop.type === "string" && prop.enum !== undefined) {
        it(`${def.name}: "${key}" outside its enum is an error and posts nothing`, async () => {
          const { registry, calls } = setup();
          const r = await registry.call(def.name, { ...validArgs(def), [key]: "nope" });
          expect(r.isError).toBe(true);
          expect(text(r)).toMatch(new RegExp(`^Invalid ${key}: nope \\(use "`));
          expect(calls).toEqual([]);
        });
      }
    }
  }
});

describe("send_message (issue #2)", () => {
  it("{to, text, delivery}: the body under the wrong name is refused with the names it got", async () => {
    const { registry, calls } = setup();
    const r = await registry.call("send_message", { to: "peer", text: "hello", delivery: "pull" });
    expect(r).toEqual({ content: [{ type: "text", text: 'missing required argument "message" (got: to, text, delivery)' }], isError: true });
    expect(calls).toEqual([]);
  });

  it("a body that is null, a number, an object or an empty string is refused", async () => {
    const { registry, calls } = setup();
    for (const message of [null, 5, {}, ["a"]]) {
      const r = await registry.call("send_message", { to: "peer", message });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/^argument "message" must be a string \(got /);
    }
    const empty = await registry.call("send_message", { to: "peer", message: "" });
    expect(empty).toEqual({ content: [{ type: "text", text: "Error (send_message): message body must not be empty" }], isError: true });
    expect(calls).toEqual([]);
  });

  it("meta: members are left to parseMeta, which answers INVALID_META", async () => {
    const { registry, calls } = setup();
    const a = await registry.call("send_message", { to: "peer", message: "m", meta: { protocol: "p" } });
    expect(a.isError).toBe(true);
    expect(text(a)).toMatch(/^INVALID_META: /);
    expect(calls).toEqual([]);
  });

  it("a valid call still goes out", async () => {
    const { registry, calls } = setup();
    const r = await registry.call("send_message", { to: "peer", message: "hello" });
    expect(r.isError).toBeUndefined();
    expect(calls.map((c) => [c.path, c.body.text])).toEqual([["/send-message", "hello"]]);
  });
});

describe("unknown arguments", () => {
  it("only unknown names are refused: a typo must not turn into a default (unset_protocol would unset everything)", async () => {
    const { registry, calls } = setup();
    const r = await registry.call("unset_protocol", { nmae: "x" });
    expect(r).toEqual({ content: [{ type: "text", text: "none of the given arguments is known (got: nmae; expected: name)" }], isError: true });
    expect(calls).toEqual([]);
  });

  it("unknown names next to a known one are tolerated", async () => {
    const { registry, calls } = setup();
    const r = await registry.call("send_message", { to: "peer", message: "m", extra: 1 });
    expect(r.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("a tool without properties accepts any arguments; no arguments is fine for optional-only tools", async () => {
    const { registry } = setup();
    expect((await registry.call("check_messages", { anything: 1 })).isError).toBeUndefined();
    const listPeers = TOOL_DEFS.find((d) => d.name === "list_peers")!;
    expect(validateArgs(listPeers.inputSchema, {})).toBeNull();
  });
});

describe("validateArgs", () => {
  const schema = { type: "object" as const, properties: { a: { type: "string" as const }, b: { type: "boolean" as const } }, required: ["a"] };

  it("reports every missing required name, and none when nothing was sent", () => {
    const two = { ...schema, required: ["a", "b"] };
    expect(validateArgs(two, {})).toBe('missing required arguments "a", "b" (got: none)');
  });

  it("treats undefined as missing and null as the wrong type", () => {
    expect(validateArgs(schema, { a: undefined })).toBe('missing required argument "a" (got: none)');
    expect(validateArgs(schema, { a: null })).toBe('argument "a" must be a string (got null)');
  });

  it("accepts a boolean given as the string true / false, refuses other strings", () => {
    expect(validateArgs(schema, { a: "x", b: "true" })).toBeNull();
    expect(validateArgs(schema, { a: "x", b: "yes" })).toBe('argument "b" must be a boolean (got string)');
  });

  it("refuses arguments that are not an object", () => {
    expect(validateArgs(schema, "x")).toBe("arguments must be an object (got string)");
    expect(validateArgs(schema, [])).toBe("arguments must be an object (got array)");
  });
});
