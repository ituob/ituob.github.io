import { expect, test } from "@playwright/test";

test("legacy English issue URL redirects at the configured HTTPS origin", async ({ baseURL, request }) => {
  const response = await request.get("/issues/1000-en/", { maxRedirects: 0 });

  expect(response.status()).toBe(301);
  expect(response.headers().location).toBe(new URL("/issues/1000/", baseURL).toString());
});

test("legacy filename aliases preserve the query string", async ({ baseURL, request }) => {
  const response = await request.get("/issues/1000-en/index.html?source=archive&view=full", { maxRedirects: 0 });

  expect(response.status()).toBe(301);
  expect(response.headers().location).toBe(new URL("/issues/1000/?source=archive&view=full", baseURL).toString());
});

test("ordinary static asset paths keep their normal response", async ({ request }) => {
  const response = await request.get("/assets/favicon.png", { maxRedirects: 0 });

  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("image/png");
});
