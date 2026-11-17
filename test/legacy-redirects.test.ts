import { expect, it } from "vitest";
import worker from "../worker/index.ts";
import redirects from "../worker/lib/legacy-redirects.json";
import { legacyRedirectTarget } from "../worker/lib/legacy-redirects.ts";
import type { RuntimeEnv } from "../worker/lib/types.ts";

it("serves every mapped legacy HTML spelling with a permanent redirect before ASSETS", async () => {
  const env: RuntimeEnv = { ASSETS: { fetch: async () => { throw new Error("Legacy URL reached ASSETS"); } } };
  for (const [oldPath, target] of Object.entries(redirects)) {
    const encoded = oldPath.split("/").map(encodeURIComponent).join("/");
    for (const alias of new Set([oldPath, oldPath.slice(0, -1), oldPath + "index.html", encoded, encoded + "index.html", encoded.replace(/\(/g, "%28").replace(/\)/g, "%29")])) {
      const response = await worker.fetch(new Request(`https://www.ituob.org${alias}?source=old%20link`), env);
      expect(response.status, alias).toBe(301);
      expect(response.headers.get("Location"), alias).toBe(`https://www.ituob.org${target}?source=old%20link`);
    }
    expect(legacyRedirectTarget(target), target).toBeNull();
  }
});

it("combines legacy, scheme and apex canonicalization without losing query strings", async () => {
  const env: RuntimeEnv = { ASSETS: { fetch: async () => new Response("asset") } };
  const response = await worker.fetch(new Request("http://ituob.org/issues/1000-en/index.html?q=one%20two"), env);
  expect(response.status).toBe(301);
  expect(response.headers.get("Location")).toBe("https://www.ituob.org/issues/1000/?q=one%20two");
});

it("leaves underscore copies, unknown paths, malformed encodings and encoded separators unmapped", async () => {
  for (const path of ["/_app_help/", "/messages/unknown/", "/issues%2f1000-en/", "/issues/1000-en%ZZ/", "/ISSUES/1000-en/"]) {
    expect(legacyRedirectTarget(path)).toBeNull();
    const response = await worker.fetch(new Request(`https://www.ituob.org${path}`), {
      ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
    });
    expect(response.status).toBe(404);
  }
});
