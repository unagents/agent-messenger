/**
 * Claude Code session inbox socket — line shapes.
 *
 * Transcribed from `legacy/src/server.js` (`postToSession`). The client connects to
 * the unix socket named by `CLAUDE_CODE_MESSAGING_SOCKET`, writes one JSON
 * object per line (`\n` terminated), then half-closes:
 *
 *   1. `{"type":"auth","token":<CLAUDE_CODE_MESSAGING_TOKEN>}`   only when the token is set
 *   2. `{"type":"user","message":{"role":"user","content":<text>}}`
 */

/** Environment variable holding the session socket path. */
export const SESSION_SOCKET_ENV = "CLAUDE_CODE_MESSAGING_SOCKET";

/** Environment variable holding the session socket auth token. */
export const SESSION_TOKEN_ENV = "CLAUDE_CODE_MESSAGING_TOKEN";

export interface SessionAuthLine {
  type: "auth";
  token: string;
}

export interface SessionUserLine {
  type: "user";
  message: {
    role: "user";
    content: string;
  };
}

export type SessionSocketLine = SessionAuthLine | SessionUserLine;
