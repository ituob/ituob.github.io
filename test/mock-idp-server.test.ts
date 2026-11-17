import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { expect, it } from "vitest";

it.each(["!!!", Buffer.from("%ZZ:x").toString("base64")])("keeps the runnable provider alive after malformed Basic credentials %s", async (credentials) => {
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
    const bad = await fetch(`${base}/token`, { method: "POST", headers: { Authorization: `Basic ${credentials}` }, body: "code=x" });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: "invalid_client" });
    const discovery = await fetch(`${base}/.well-known/openid-configuration`);
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toMatchObject({ issuer: base });
    expect(child.exitCode).toBeNull();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
});
