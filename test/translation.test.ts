import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { MAX_CHARS, type SocketLike, setTranslationConnector, translate } from "../worker/lib/translation.ts";
import { Forbidden } from "../worker/lib/authz.ts";
import { InvalidError } from "../worker/lib/membership.ts";
import { getAccessIdentity } from "../worker/lib/session.ts";
import { translationRoutes } from "../worker/translation-routes.ts";
import { activateMember, api, provisionItu, seedFixtures } from "./helpers.ts";

type Mode = "reply" | "silent" | "close" | "error" | "empty" | "binary" | "refuse";
class FakeSocket implements SocketLike {
  sent: string[] = []; accepted = false; closed = false; handlers: Record<string, ((e: any) => void)[]> = {};
  constructor(private mode: Mode) {}
  accept() { this.accepted = true; }
  addEventListener(t: string, fn: (e: any) => void) { (this.handlers[t] ??= []).push(fn); }
  close() { this.closed = true; }
  send(d: string) {
    this.sent.push(d);
    const fire = (t: string, e: unknown) => queueMicrotask(() => this.handlers[t]?.forEach((f) => f(e)));
    if (this.mode === "reply") fire("message", { data: `fr:${d}` });
    if (this.mode === "close") fire("close", {});
    if (this.mode === "error") fire("error", {});
    if (this.mode === "empty") fire("message", { data: "  " });
    if (this.mode === "binary") fire("message", { data: new ArrayBuffer(4) });
  }
}
let urls: string[]; let sock: FakeSocket | undefined;
const seam = (mode: Mode) => setTranslationConnector(async (u) => { urls.push(u); if (mode === "refuse") throw new Error("ECONNREFUSED"); return (sock = new FakeSocket(mode)); });
beforeEach(async () => { urls = []; sock = undefined; await seedFixtures(); await provisionItu("itu-editor", ["itu-editor"]); await activateMember("member-A", "A"); });
afterEach(() => setTranslationConnector(null));

const route = translationRoutes[0]!;
async function call(access: string | undefined, body: unknown) {
  const request = new Request("http://localhost/api/admin/translate", { method: "POST", headers: { "Content-Type": "application/json", ...(access ? { "X-Stub-Access": access } : {}) }, body: JSON.stringify(body) });
  const ident = await getAccessIdentity(request, env as any);
  return route.handler({ request, env: env as any, url: new URL(request.url), params: [], session: null, access: ident });
}
const ok = { text: "Hello", from: "en", to: "fr" };
const EDITOR = "itu-editor@example.test";

describe("translate()", () => {
  it("sends the text as one raw frame to the fixed legacy endpoint and returns the first reply", async () => {
    seam("reply");
    expect(await translate({ text: "Hello", from: "en", to: "fr" })).toBe("fr:Hello");
    expect(urls).toEqual(["wss://nmt.itu.int/marian_translate_enfr"]);
    expect(sock!.sent).toEqual(["Hello"]); expect(sock!.accepted).toBe(true); expect(sock!.closed).toBe(true);
  });
  it.each(["silent"] as const)("times out and closes the socket", async (m) => {
    seam(m);
    await expect(translate({ text: "Hello", from: "en", to: "fr" }, 20)).rejects.toThrow(/timed out/);
    expect(sock!.closed).toBe(true);
  });
  it.each([["close", /closed/], ["error", /socket error/], ["empty", /empty/], ["binary", /empty or non-text/], ["refuse", /ECONNREFUSED/]] as const)("%s rejects without text", async (m, re) => {
    seam(m);
    await expect(translate({ text: "Hello", from: "en", to: "fr" }, 200)).rejects.toThrow(re);
  });
});

describe("late socket lifetime", () => {
  it("closes a connector that finishes after the request deadline", async () => {
    let connect!: (socket: SocketLike) => void;
    setTranslationConnector(() => new Promise(resolve => { connect = resolve; }));
    await expect(translate({ text: "Hello", from: "en", to: "fr" }, 5)).rejects.toThrow(/timed out/);
    const late = new FakeSocket("reply"); connect(late);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(late.closed).toBe(true);
    expect(late.sent).toEqual([]);
  });
});

describe("POST /api/admin/translate handler", () => {
  it("returns the translation for an ITU editor", async () => {
    seam("reply");
    const res = await call(EDITOR, ok);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, provider: "nmt.itu.int", from: "en", to: "fr", text: "fr:Hello" });
  });
  it("rejects pairs outside the allowlist and never connects", async () => {
    seam("reply");
    for (const [from, to] of [["fr", "en"], ["en", "en"], ["en", "de"], ["en", "fr/../x"], ["../", "fr"], ["e", "nfr"], ["", "enfr"]]) await expect(call(EDITOR, { text: "x", from, to })).rejects.toBeInstanceOf(InvalidError);
    expect(urls).toEqual([]);
  });
  it("bounds input length and rejects empty or non-string text", async () => {
    seam("reply");
    await expect(call(EDITOR, { ...ok, text: "a".repeat(MAX_CHARS + 1) })).rejects.toBeInstanceOf(InvalidError);
    await expect(call(EDITOR, { ...ok, text: "   " })).rejects.toBeInstanceOf(InvalidError);
    await expect(call(EDITOR, { ...ok, text: 5 })).rejects.toBeInstanceOf(InvalidError);
    expect((await call(EDITOR, { ...ok, text: "a".repeat(MAX_CHARS) })).status).toBe(200);
  });
  it("rejects a missing Access identity and a non-staff user without connecting", async () => {
    seam("reply");
    await expect(call(undefined, ok)).rejects.toBeInstanceOf(Forbidden);
    await expect(call("member-A@example.test", ok)).rejects.toBeInstanceOf(Forbidden);
    await expect(call("nobody@example.test", ok)).rejects.toBeInstanceOf(Forbidden);
    expect(urls).toEqual([]);
  });
  it("surfaces upstream failure as an error (UpstreamError, mapped to 502) with no text", async () => {
    seam("close");
    await expect(call(EDITOR, ok)).rejects.toMatchObject({ name: "Error", message: expect.stringMatching(/unavailable/) });
  });
});


describe("translation through the Worker router", () => {
  it("enforces Access, staff role and same origin before connecting", async () => {
    seam("reply");
    expect((await api("POST", "/api/admin/translate", { body: ok })).status).toBe(403);
    expect((await api("POST", "/api/admin/translate", { access: "member-A@example.test", body: ok })).status).toBe(403);
    expect((await api("POST", "/api/admin/translate", { access: EDITOR, body: ok, headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    expect(urls).toEqual([]);
    const res = await api("POST", "/api/admin/translate", { access: EDITOR, body: ok });
    expect(res.status).toBe(200);
    expect(res.json.text).toBe("fr:Hello");
    expect(urls).toEqual(["wss://nmt.itu.int/marian_translate_enfr"]);
  });
  it("returns upstream failures as observable errors", async () => {
    seam("refuse");
    const res = await api("POST", "/api/admin/translate", { access: EDITOR, body: ok });
    expect(res.status).toBe(502);
    expect(res.json.error).toMatch(/translation service unavailable/);
  });
});
