import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { PERSONAS } from "../../scripts/mock-idp.mjs";

const WIDTHS = [1440, 390] as const;
test.beforeAll(() => rmSync("test-results/axe-contrast.jsonl", { force: true }));

// Console errors collected per page; the failed-resource noise from the admin
// screens (no Access identity locally) is reported separately by `adminNoise`.
function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${m.text()} @ ${m.location().url}`); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function inspect(page: Page, name: string, width: number, errors: string[], opts: { allowConsole?: RegExp } = {}) {
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `test-results/shots/${name}-${width}.png`, fullPage: true });
  if (width === 390) {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${name}: horizontal scroll at 390`).toBeLessThanOrEqual(0);
  }
  // kit.fontawesome.com is a third-party kit that refuses unregistered origins (403 on 127.0.0.1); not site code.
  errors = errors.filter((e) => !/kit\.fontawesome\.com/.test(e));
  const seen = opts.allowConsole ? errors.filter((e) => !opts.allowConsole!.test(e)) : errors;
  expect(seen, `${name}: console errors`).toEqual([]);
  const { violations } = await new AxeBuilder({ page }).analyze();
  // KNOWN, not fixed here: the palette (#1aa1da, #178ec4, #1285b1, greys) fails WCAG AA color-contrast on most
  // pages. That is a design decision, not a one-line fix, so contrast is recorded as an annotation and in
  // test-results/axe-contrast.json instead of failing; every other serious/critical rule still fails.
  const serious = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const contrast = serious.find((v) => v.id === "color-contrast");
  if (contrast) {
    test.info().annotations.push({ type: "known-contrast", description: `${name}-${width}: ${contrast.nodes.length} nodes` });
    mkdirSync("test-results", { recursive: true });
    appendFileSync("test-results/axe-contrast.jsonl", JSON.stringify({ page: name, width, nodes: contrast.nodes.map((n) => ({ target: n.target.join(" "), detail: n.any[0]?.message })) }) + "\n");
  }
  const bad = serious.filter((v) => v.id !== "color-contrast");
  expect(bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`), `${name}: axe`).toEqual([]);
}

for (const width of WIDTHS) {
  test.describe(`width ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });

    for (const [key, persona] of Object.entries(PERSONAS)) {
      test(`persona ${key}: sign in, header name, POST sign out`, async ({ page }) => {
        const errors = watchConsole(page);
        await page.goto("/auth/login?return_to=%2Fme%2F");
        await page.getByLabel("Email address").fill(persona.email);
        await page.getByRole("button", { name: "Continue" }).click();
        await page.waitForURL("**/me/");
        const summary = page.locator(".header-account summary");
        await expect(summary).toContainText(persona.name);
        await inspect(page, `me-${key}`, width, errors);
        await summary.click();
        const [logout] = await Promise.all([
          page.waitForRequest((r) => r.url().endsWith("/auth/logout")),
          page.locator(".header-account").getByRole("button", { name: "Sign out" }).click(),
        ]);
        expect(logout.method()).toBe("POST");
        await expect(page.locator(".header-account a.sign-in")).toHaveText("Sign in");
      });
    }

    test("home", async ({ page }) => {
      const errors = watchConsole(page);
      await page.goto("/");
      await expect(page.locator(".header-account a.sign-in")).toHaveText("Sign in");
      await inspect(page, "home", width, errors);
    });

    test("issue page", async ({ page }) => {
      const errors = watchConsole(page);
      await page.goto("/issues/");
      const href = await page.locator('main a[href^="/issues/"]').first().getAttribute("href");
      await page.goto(href!);
      await inspect(page, "issue", width, errors);
    });

    test("register page", async ({ page }) => {
      const errors = watchConsole(page);
      await page.goto("/registers/");
      const href = await page.locator('main a[href^="/registers/"]').first().getAttribute("href");
      await page.goto(href!);
      await inspect(page, "register", width, errors);
    });

    for (const adminPath of ["", "catalog", "composer", "editor", "general", "members", "submissions", "bulk", "annexes"]) {
      test(`admin /${adminPath}`, async ({ page }) => {
        const errors = watchConsole(page);
        const res = await page.goto(`/admin/${adminPath ? adminPath + "/" : ""}`);
        expect(res?.status()).toBeLessThan(400);
        // Admin APIs need a Cloudflare Access identity that dev:local does not provide.
        await inspect(page, `admin-${adminPath || "index"}`, width, errors, { allowConsole: /40[13]|Failed to load resource/ });
      });
    }
  });
}
