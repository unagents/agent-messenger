import { connect as netConnect } from "node:net";
import type { SessionAuthLine, SessionUserLine } from "@agent-hand/messenger-protocol";

/**
 * Deliver a message into the Claude Code session through its inbox socket
 * (`CLAUDE_CODE_MESSAGING_SOCKET`): auth line (when a token is set), user line,
 * then half-close. Same as `postToSession` in the current `src/server.js`.
 */
export function postToSession(socketPath: string, token: string, text: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!socketPath) {
      reject(new Error("CLAUDE_CODE_MESSAGING_SOCKET not set"));
      return;
    }
    const sock = netConnect(socketPath);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("session socket timeout"));
    }, 5000);
    sock.on("connect", () => {
      if (token) {
        const auth: SessionAuthLine = { type: "auth", token };
        sock.write(JSON.stringify(auth) + "\n");
      }
      const user: SessionUserLine = { type: "user", message: { role: "user", content: text } };
      sock.write(JSON.stringify(user) + "\n");
      sock.end();
    });
    sock.on("error", (e: Error) => {
      clearTimeout(timer);
      reject(e);
    });
    sock.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
