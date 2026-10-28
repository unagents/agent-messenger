import { spawnSync } from "node:child_process";
import { hostname as osHostname } from "node:os";
import type { ProtocolDecl } from "@unagents/messenger-protocol";
import type { BrokerClient } from "./broker.js";
import type { Logger } from "./resolve.js";

/** Mutable identity of this peer. A plain object (no accessors) so it is safe in the native build. */
export interface PeerState {
  id: string | null;
  name: string;
  summary: string;
  hostname: string;
  cwd: string;
  gitRoot: string | null;
  tty: string | null;
}

export function createPeerState(init: { name: string; summary?: string; hostname?: string; cwd?: string }): PeerState {
  return {
    id: null,
    name: init.name,
    summary: init.summary ?? "",
    hostname: init.hostname ?? osHostname(),
    cwd: init.cwd ?? process.cwd(),
    gitRoot: null,
    tty: null,
  };
}

function git(args: string[], cwd: string): string | null {
  const r = spawnSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? r.stdout.toString().trim() : null;
}

export function detectGitRoot(cwd: string): string | null {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

export function detectTty(): string | null {
  try {
    const r = spawnSync("ps", ["-o", "tty=", "-p", String(process.ppid)]);
    const tty = r.stdout.toString().trim();
    if (tty && tty !== "?" && tty !== "??") return tty;
  } catch {
    // ignore
  }
  return null;
}

export async function registerPeer(
  broker: Pick<BrokerClient, "post">,
  peer: PeerState,
  log: Logger,
  protocols?: ProtocolDecl[]
): Promise<void> {
  const reg = await broker.post("/register", {
    pid: process.pid,
    hostname: peer.hostname,
    cwd: peer.cwd,
    git_root: peer.gitRoot,
    tty: peer.tty,
    summary: peer.summary,
    name: peer.name,
    ...(protocols === undefined ? {} : { protocols }),
  });
  peer.id = reg.id;
  log(`Registered as peer ${peer.id}`);
}
