import { describe, expect, it, vi } from "vitest";
import { HttpEmailSender, LogEmailSender, UnconfiguredEmailSender, getEmailSender, redactSecrets } from "../worker/lib/email.ts";
import type { Env } from "../worker/lib/types.ts";

const msg = { to: "m@example.org", subject: "S", text: "body", idempotencyKey: "n1" };
const cfg = (e: Partial<Env>) => e as Env;

describe("email provider selection and transports", () => {
  it("fails closed unless fully configured", async () => {
    for (const e of [{}, { EMAIL_PROVIDER: "http" }, { EMAIL_PROVIDER: "http", EMAIL_API_URL: "http://insecure.example/", EMAIL_API_KEY: "k", MAIL_FROM: "a@b.c" },
      { EMAIL_PROVIDER: "http", EMAIL_API_URL: "not a url", EMAIL_API_KEY: "k", MAIL_FROM: "a@b.c" }, { EMAIL_PROVIDER: "other" }]) {
      const s = getEmailSender(cfg(e));
      expect(s).toBeInstanceOf(UnconfiguredEmailSender);
      await expect(s.send()).rejects.toThrow(/not configured/);
    }
  });
  it("log provider sends nothing, logs no body, and is deterministic", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const s = getEmailSender(cfg({ EMAIL_PROVIDER: "log" }));
    expect(s).toBeInstanceOf(LogEmailSender);
    expect(await s.send(msg)).toEqual({ id: "log-n1" });
    const line = String(spy.mock.calls[0]![0]);
    expect(line).toContain("email.logged");
    expect(line).not.toContain("body");
    spy.mockRestore();
  });
  it("http provider posts JSON with bearer key and idempotency key", async () => {
    const f = vi.fn<typeof fetch>(async () => Response.json({ id: "prov-1" }));
    const s = getEmailSender(cfg({ EMAIL_PROVIDER: "http", EMAIL_API_URL: "https://api.mail.example/send", EMAIL_API_KEY: "secret", MAIL_FROM: "OB <ob@ituob.org>" }), f);
    expect(s).toBeInstanceOf(HttpEmailSender);
    expect(await s.send(msg)).toEqual({ id: "prov-1" });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://api.mail.example/send");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer secret");
    expect((init!.headers as Record<string, string>)["Idempotency-Key"]).toBe("n1");
    expect(JSON.parse(init!.body as string)).toEqual({ from: "OB <ob@ituob.org>", to: ["m@example.org"], subject: "S", text: "body" });
  });
  it("http provider throws on non-2xx and on a response without an id", async () => {
    const mk = (r: () => Response) => new HttpEmailSender("https://x.example/", "k", "a@b.c", async () => r());
    await expect(mk(() => new Response("no", { status: 503 })).send(msg)).rejects.toThrow(/503/);
    await expect(mk(() => Response.json({})).send(msg)).rejects.toThrow(/id/);
    await expect(mk(() => new Response("x")).send(msg)).rejects.toThrow(/id/);
  });

  it("the default fetch is invoked unbound-safe (no Illegal invocation)", async () => {
    const stub = vi.fn(function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(Response.json({ id: "ok-1" }));
    });
    vi.stubGlobal("fetch", stub);
    try {
      const s = getEmailSender(cfg({ EMAIL_PROVIDER: "http", EMAIL_API_URL: "https://api.mail.example/send", EMAIL_API_KEY: "secret", MAIL_FROM: "a@b.c" }));
      expect(await s.send(msg)).toEqual({ id: "ok-1" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("blank or whitespace credentials, userinfo, IP literals and local hosts fail closed", () => {
    const base = { EMAIL_PROVIDER: "http", EMAIL_API_URL: "https://api.mail.example/send", EMAIL_API_KEY: "secret", MAIL_FROM: "a@b.c" };
    expect(getEmailSender(cfg(base))).toBeInstanceOf(HttpEmailSender);
    for (const bad of [{ EMAIL_API_KEY: "   " }, { MAIL_FROM: " \t" }, { EMAIL_API_URL: "https://user:pw@api.mail.example/" },
      { EMAIL_API_URL: "https://127.0.0.1/" }, { EMAIL_API_URL: "https://10.0.0.5/x" }, { EMAIL_API_URL: "https://[::1]/" },
      { EMAIL_API_URL: "https://localhost/" }, { EMAIL_API_URL: "https://x.localhost/" }, { EMAIL_API_URL: "https://intranet/" }]) {
      expect(getEmailSender(cfg({ ...base, ...bad })), JSON.stringify(bad)).toBeInstanceOf(UnconfiguredEmailSender);
    }
  });
  it("trims credentials before use", async () => {
    const f = vi.fn<typeof fetch>(async () => Response.json({ id: "p" }));
    await getEmailSender(cfg({ EMAIL_PROVIDER: "http", EMAIL_API_URL: " https://api.mail.example/send ", EMAIL_API_KEY: " k ", MAIL_FROM: " a@b.c " }), f).send(msg);
    expect((f.mock.calls[0]![1]!.headers as Record<string, string>).Authorization).toBe("Bearer k");
  });
  it("truncates an oversized provider id", async () => {
    const s = new HttpEmailSender("https://x.example/", "k", "a@b.c", async () => Response.json({ id: "x".repeat(5000) }));
    expect((await s.send(msg)).id).toHaveLength(200);
  });
  it("redactSecrets strips queries, bearer tokens and the key", () => {
    const out = redactSecrets("GET https://h.example/p?token=abc#frag failed; Bearer zzz; key=topsecret", "topsecret");
    expect(out).not.toMatch(/abc|zzz|topsecret|frag/);
    expect(out).toContain("https://h.example/p");
  });
});
