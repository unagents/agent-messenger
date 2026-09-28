import { spawn } from "node:child_process";

/**
 * Run `command args` with inherited stdio, forward SIGINT / SIGTERM / SIGHUP, and end
 * this process with the child's exit code (or re-raise its signal) — same as the loader.
 * The returned promise never resolves; the process exits from the child's `exit` event.
 */
export function runChild(command: string, args: string[]): Promise<never> {
  return new Promise<never>(() => {
    const child = spawn(command, args, { stdio: "inherit" });
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.on(sig, () => child.kill(sig));
    }
    child.on("error", (e) => {
      console.error(`[agent-messenger loader] cannot start ${command}: ${e.message}`);
      process.exit(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      process.exit(code ?? 0);
    });
  });
}
