import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { expect, it } from "vitest";

async function withProvider(run: (base: string) => Promise<void>) {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => reservation.close((err) => err ? reject(err) : resolve()));
  const child = spawn(process.execPath, ["scripts/mock-idp.mjs", "serve", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`provider startup timed out: ${stderr}`)), 5000);
      child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`provider exited ${code}: ${stderr}`)); });
      child.once("error", (err) => { clearTimeout(timer); reject(err); });
    });
    const base = `http://127.0.0.1:${port}`;
    await run(base);
    expect(child.exitCode).toBeNull();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
}

it.each(["!!!", Buffer.from("%ZZ:x").toString("base64")])("keeps the runnable provider alive after malformed Basic credentials %s", async (credentials) => {
  await withProvider(async (base) => {
    const bad = await fetch(`${base}/token`, { method: "POST", headers: { Authorization: `Basic ${credentials}` }, body: "code=x" });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: "invalid_client" });
    const discovery = await fetch(`${base}/.well-known/openid-configuration`);
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toMatchObject({ issuer: base });
  });
});

it("serves the sign-in form and exchanges its email submission for the selected account's token", async () => {
  await withProvider(async (base) => {
    const verifier = "v".repeat(43);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = Buffer.from(digest).toString("base64url");
    const authorize = new URL("/authorize", base);
    authorize.search = new URLSearchParams({ client_id: "ituob-local-dev", redirect_uri: "https://127.0.0.1:8443/auth/callback", response_type: "code", code_challenge_method: "S256", code_challenge: challenge, state: "test-state", nonce: "test-nonce" }).toString();
    const page = await fetch(authorize);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<label for="email">Email address</label>');
    expect(html).toContain('<button type="submit">Continue</button>');
    expect(html).toContain('<summary>Test accounts</summary>');
    const action = html.match(/<form method="post" action="([^"]+)"/)![1]!.replaceAll("&amp;", "&");
    const response = await fetch(new URL(action, base), { method: "POST", body: new URLSearchParams({ email: "itu-editor@mock.test" }), redirect: "manual" });
    expect(response.status).toBe(302);
    const callback = new URL(response.headers.get("Location")!);
    expect(callback.origin + callback.pathname).toBe("https://127.0.0.1:8443/auth/callback");
    expect(callback.searchParams.get("state")).toBe("test-state");
    const token = await fetch(`${base}/token`, { method: "POST", headers: { Authorization: `Basic ${Buffer.from("ituob-local-dev:local-dev-secret-not-real").toString("base64")}` }, body: new URLSearchParams({ grant_type: "authorization_code", code: callback.searchParams.get("code")!, code_verifier: verifier, redirect_uri: "https://127.0.0.1:8443/auth/callback" }) });
    expect(token.status).toBe(200);
    const { id_token } = await token.json() as { id_token: string };
    expect(JSON.parse(Buffer.from(id_token.split(".")[1]!, "base64url").toString())).toMatchObject({ sub: "mock-itu-editor", email: "itu-editor@mock.test", nonce: "test-nonce" });
    const invalid = await fetch(new URL(action, base), { method: "POST", body: new URLSearchParams({ email: "unknown@mock.test" }), redirect: "manual" });
    expect(invalid.status).toBe(400);
    expect(invalid.headers.has("Location")).toBe(false);
    expect(await invalid.text()).toContain('role="alert"');
  });
});
