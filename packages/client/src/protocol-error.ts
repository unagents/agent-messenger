import type { ProtocolErrorCode } from "@unagents/messenger-protocol";

/** An Error whose message is `<CODE>: <detail>` (design 7.2) and whose `code` property is the code. */
export function protocolError(code: ProtocolErrorCode, detail: string): Error {
  const e = new Error(`${code}: ${detail}`) as Error & { code?: string };
  e.code = code;
  return e;
}

/** The protocol error code of `e`, or `null` when it is not a protocol error. */
export function protocolErrorCode(e: unknown): string | null {
  if (e instanceof Error) {
    const c = (e as Error & { code?: unknown }).code;
    if (typeof c === "string" && e.message.startsWith(`${c}: `)) return c;
  }
  return null;
}

/** Codes of the connection tools (`set_broker`), raised like protocol errors: message `<CODE>: <detail>`. */
export type BrokerErrorCode = "INVALID_BROKER_URL" | "BROKER_UNREACHABLE" | "BROKER_SWITCH_FAILED" | "BROKER_SWITCH_BUSY" | "SAVE_FAILED";

export function brokerError(code: BrokerErrorCode, detail: string): Error {
  const e = new Error(`${code}: ${detail}`) as Error & { code?: string };
  e.code = code;
  return e;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
