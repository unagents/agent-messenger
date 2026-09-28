import { homedir } from "node:os";
import { join } from "node:path";

/** Packages fetched at runtime. */
export const CLIENT_NAME = "@agent-hand/messenger-client";
export const BROKER_NAME = "@agent-hand/messenger-broker";

/** Default source: Gitea Packages npm registry (owner agent-hand). */
export const DEFAULT_REGISTRY = "http://192.168.1.202/gitea/api/packages/agent-hand/npm/";
/** Default version spec for every package (`<name>@latest`). */
export const DEFAULT_SPEC = "latest";
/** Re-check a floating spec (tag / range) after this many hours. */
export const DEFAULT_TTL_HOURS = 24;
/** Package cache root: `~/.agent-messenger/pkgs/`. */
export const DEFAULT_PKGS_DIR = join(homedir(), ".agent-messenger", "pkgs");

/**
 * Environment variable names. The `legacy/loader/loader.js` names (`AGENT_MESSENGER_CORE_*`)
 * are replaced; only the refresh flag still accepts its old name.
 */
export const ENV = {
  /** registry for the @agent-hand scope (was `AGENT_MESSENGER_CORE_REGISTRY`) */
  REGISTRY: "AGENT_MESSENGER_REGISTRY",
  /** cache root (was `AGENT_MESSENGER_CORE_DIR`) */
  PKGS_DIR: "AGENT_MESSENGER_PKGS_DIR",
  /** `"1"` = reinstall now (was `AGENT_MESSENGER_CORE_REFRESH`, still accepted) */
  REFRESH: "AGENT_MESSENGER_REFRESH",
  REFRESH_LEGACY: "AGENT_MESSENGER_CORE_REFRESH",
  /** floating-spec re-check interval in hours, 0 = every run, <0 = never (was `AGENT_MESSENGER_CORE_TTL_HOURS`) */
  TTL_HOURS: "AGENT_MESSENGER_TTL_HOURS",
  /** version spec of `@agent-hand/messenger-broker` (was `AGENT_MESSENGER_CORE_SPEC`) */
  BROKER_SPEC: "AGENT_MESSENGER_BROKER_SPEC",
  /** version spec of `@agent-hand/messenger-client` and its platform packages */
  CLIENT_SPEC: "AGENT_MESSENGER_CLIENT_SPEC",
  /** `"node"` | `"native"` — force the client flavour (default: native if available) */
  CLIENT: "AGENT_MESSENGER_CLIENT",
} as const;

export type ClientMode = "auto" | "node" | "native";

export interface LoaderConfig {
  registry: string;
  pkgsDir: string;
  refresh: boolean;
  ttlHours: number;
  brokerSpec: string;
  clientSpec: string;
  clientMode: ClientMode;
}

export type Env = Record<string, string | undefined>;

export function loadLoaderConfig(env: Env = process.env): LoaderConfig {
  const mode = (env[ENV.CLIENT] ?? "").trim().toLowerCase();
  return {
    registry: env[ENV.REGISTRY] ?? DEFAULT_REGISTRY,
    pkgsDir: env[ENV.PKGS_DIR] ?? DEFAULT_PKGS_DIR,
    refresh: env[ENV.REFRESH] === "1" || env[ENV.REFRESH_LEGACY] === "1",
    ttlHours: parseFloat(env[ENV.TTL_HOURS] ?? String(DEFAULT_TTL_HOURS)),
    brokerSpec: env[ENV.BROKER_SPEC] ?? DEFAULT_SPEC,
    clientSpec: env[ENV.CLIENT_SPEC] ?? DEFAULT_SPEC,
    clientMode: mode === "node" || mode === "native" ? mode : "auto",
  };
}

/** `@agent-hand/messenger-client-<platform>-<arch>`, e.g. `...-darwin-arm64` / `...-linux-x64`. */
export function nativeClientName(platform: string = process.platform, arch: string = process.arch): string {
  return `${CLIENT_NAME}-${platform}-${arch}`;
}

/**
 * Turn a spec value into a full npm spec for `name`.
 *
 *   "latest" / "@latest" / "1.2.3" / "^1.2"  -> "<name>@<value>"
 *   "file:/x.tgz" / "git+http://..." / "/x"  -> used as-is (points at the package itself)
 *   "<name>@..."                             -> used as-is
 */
export function fullSpec(name: string, spec: string): string {
  const s = spec.trim();
  if (s === "") return `${name}@${DEFAULT_SPEC}`;
  if (/^(file:|git\+|git:|https?:|github:|\/|\.\/|\.\.\/)/.test(s) || s.startsWith(`${name}@`)) return s;
  return `${name}@${s.replace(/^@/, "")}`;
}
