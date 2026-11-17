import { InvalidError } from "./membership.ts";

// Three independently bounded columns keep a general_messages row below D1's
// 2 MB row/string limit, including source, value and approved content together.
export const MAX_STORED_BYTES = 500_000;
const COMPRESS_BYTES = 100_000;
const MAX_DECODED_BYTES = 32 * 1024 * 1024;
// ASCII survives SQLite TEXT bindings. packText also wraps literal prefixes,
// so source text cannot be confused with a compressed envelope.
const PREFIX = "~ituob-gzip-v1:";
const encoder = new TextEncoder();

async function boundedBytes(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) {
        await reader.cancel();
        throw new InvalidError("general message exceeds the supported storage size");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

/** Small records retain their existing on-disk representation. */
export async function packText(text: string): Promise<string> {
  const bytes = encoder.encode(text);
  if (bytes.length > MAX_DECODED_BYTES) throw new InvalidError("general message exceeds the supported storage size");
  if (bytes.length < COMPRESS_BYTES && !text.startsWith(PREFIX)) return text;
  // Reserve JSON string escaping overhead as packJSON uses the same encoding.
  const compressed = await boundedBytes(new Response(bytes).body!.pipeThrough(new CompressionStream("gzip")),
    Math.floor((MAX_STORED_BYTES - PREFIX.length - 16) / 4) * 3);
  let binary = "";
  for (let offset = 0; offset < compressed.length; offset += 0x8000) {
    binary += String.fromCharCode(...compressed.subarray(offset, offset + 0x8000));
  }
  return PREFIX + btoa(binary);
}

export async function unpackText(text: string): Promise<string> {
  if (!text.startsWith(PREFIX)) return text;
  if (text.length > MAX_STORED_BYTES) throw new Error("invalid general-message storage size");
  const binary = atob(text.slice(PREFIX.length));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  const decoded = await boundedBytes(new Response(bytes).body!.pipeThrough(new DecompressionStream("gzip")), MAX_DECODED_BYTES);
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(decoded);
}

/** A JSON string envelope preserves the database's json_valid CHECK. */
export async function packJSON(value: Record<string, unknown>): Promise<string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidError("general message must be an object");
  const json = JSON.stringify(value);
  const packed = await packText(json);
  return packed === json ? json : JSON.stringify(packed);
}

export async function unpackJSON(text: string): Promise<Record<string, unknown>> {
  let value: unknown = JSON.parse(text);
  if (typeof value === "string" && value.startsWith(PREFIX)) value = JSON.parse(await unpackText(value));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid stored general-message object");
  return value as Record<string, unknown>;
}
