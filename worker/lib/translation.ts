// Machine-translation assist (#101). Port of the legacy editor's ITUTranslator
// (itu-ob-editor src/renderer/machine-translation.tsx): one text frame is sent on
// wss://nmt.itu.int/marian_translate_<from><to> and the first text frame received is the
// translation. Same provider only; there is deliberately no fallback provider.
import { InvalidError } from "./membership.ts";
import { UpstreamError } from "./submissions.ts";

/** Fixed endpoint prefix from the legacy source. The host is never derived from input. */
export const ENDPOINT_PREFIX = "wss://nmt.itu.int/marian_translate_";
/** The legacy source translates only from the default language ("en") into another of its AvailableLanguages. */
export const LANGUAGE_PAIRS: ReadonlySet<string> = new Set(["enfr", "enar", "enzh", "enru", "enes"]);
export const MAX_CHARS = 2000;
export const TIMEOUT_MS = 10_000;

/** The subset of the Workers WebSocket the translator needs; tests supply a fake. */
export interface SocketLike {
  accept(): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", fn: (e: { data: unknown }) => void): void;
  addEventListener(type: "error" | "close", fn: (e: unknown) => void): void;
}
export type Connector = (url: string) => Promise<SocketLike>;

/** Workers open outbound sockets with fetch() + Upgrade header (https scheme, see docs/translation-assist.adoc). */
export const fetchConnector: Connector = async (url) => {
  const res = await fetch(url.replace(/^wss:/, "https:"), { headers: { Upgrade: "websocket" } });
  const ws = (res as Response & { webSocket?: SocketLike | null }).webSocket;
  if (!ws) throw new Error("server did not accept the WebSocket upgrade");
  return ws;
};

let override: Connector | null = null;
/** Test seam: replace the network connector (null restores the real one). */
export const setTranslationConnector = (c: Connector | null) => { override = c; };

export interface TranslateRequest { text: string; from: string; to: string }

export function parseRequest(b: Record<string, unknown>): TranslateRequest {
  const { text, from, to } = b;
  if (typeof text !== "string" || typeof from !== "string" || typeof to !== "string") throw new InvalidError("text, from and to must be strings");
  if (!text.trim()) throw new InvalidError("text must not be empty");
  if (text.length > MAX_CHARS) throw new InvalidError(`text must be at most ${MAX_CHARS} characters`);
  if (from !== "en" || !["fr", "ar", "zh", "ru", "es"].includes(to) || !LANGUAGE_PAIRS.has(`${from}${to}`)) throw new InvalidError("unsupported language pair");
  return { text, from, to };
}

/** Send one frame, resolve with the first text reply. Any failure, close or timeout rejects; no text is ever invented. */
export async function translate(req: TranslateRequest, timeoutMs = TIMEOUT_MS): Promise<string> {
  const url = `${ENDPOINT_PREFIX}${req.from}${req.to}`;
  const connect = override ?? fetchConnector;
  let socket: SocketLike | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const fail = (why: string) => new UpstreamError(`translation service unavailable: ${why}`);
  try {
    const run = (async () => {
      try { socket = await connect(url); } catch (e) { throw fail(e instanceof Error ? e.message : "connect failed"); }
      const s = socket;
      if (finished) { try { s.close(1000, "timed out"); } catch {} throw fail("timed out"); }
      return await new Promise<string>((resolve, reject) => {
        s.addEventListener("message", (e) => {
          if (typeof e.data === "string" && e.data.trim()) resolve(e.data);
          else reject(fail("empty or non-text reply"));
        });
        s.addEventListener("error", () => reject(fail("socket error")));
        s.addEventListener("close", () => reject(fail("connection closed before a reply")));
        s.accept();
        s.send(req.text);
      });
    })();
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(fail("timed out")), timeoutMs); });
    return await Promise.race([run, deadline]);
  } finally {
    finished = true;
    if (timer !== undefined) clearTimeout(timer);
    try { socket?.close(1000, "done"); } catch { /* already closed */ }
  }
}
