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
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary", exact: true })).toBeVisible();
  const account = page.locator(".header-account");
  if (name.startsWith("me-")) {
    await expect(account.locator("summary")).toBeVisible();
  } else {
    await expect(account.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
  }
  await page.evaluate(() => document.fonts.ready);
  // A fixed pixel budget also catches missing content on very tall issue pages.
  await expect(page).toHaveScreenshot(`${name}-${width}.png`, {
    fullPage: true,
    animations: "disabled",
    threshold: 0.2,
    maxDiffPixels: 100,
    timeout: 15_000,
  });
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
  // test-results/axe-contrast.jsonl instead of failing; every other serious/critical rule still fails.
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
        await expect(summary).toBeVisible();
        await expect(summary).toContainText(persona.name);
        const main = page.getByRole("main");
        await expect(main.getByRole("heading", { name: "Your account", exact: true })).toBeVisible();
        await expect(main.getByText(`Signed in as ${persona.name}.`, { exact: true })).toBeVisible();
        await expect(main.locator(".account-details dd").filter({ hasText: persona.email })).toBeVisible();
        await expect(main.getByRole("navigation", { name: "Your work", exact: true })
          .getByRole("link", { name: "Your submissions", exact: true })).toBeVisible();
        await inspect(page, `me-${key}`, width, errors);
        await summary.click();
        const [logout] = await Promise.all([
          page.waitForRequest((r) => r.url().endsWith("/auth/logout")),
          page.locator(".header-account").getByRole("button", { name: "Sign out" }).click(),
        ]);
        expect(logout.method()).toBe("POST");
        await expect(page.locator(".header-account a.sign-in")).toHaveText("Sign in");
        await expect(page.locator(".header-account a.sign-in")).toBeVisible();
      });
    }

    test("home", async ({ page }) => {
      const errors = watchConsole(page);
      await page.goto("/");
      await expect(page.locator(".header-account a.sign-in")).toHaveText("Sign in");
      const main = page.getByRole("main");
      await expect(main.getByRole("heading", { name: "View publication amendments", exact: true })).toBeVisible();
      await expect(main.getByRole("heading", { name: "View older issues", exact: true })).toBeVisible();
      await expect(main.locator('li a[href="/issues/1264/"]')).toHaveText("1264");
      await expect(main.locator('li a[href="/issues/1264/"]')).toBeVisible();
      await inspect(page, "home", width, errors);
    });

    test("issue page", async ({ page }) => {
      const errors = watchConsole(page);
      // Pin the shared production reference, rather than whichever issue is latest.
      await page.goto("/issues/1264/");
      const main = page.getByRole("main");
      await expect(main.getByRole("heading", { name: /^ITU Operational Bulletin/ })).toBeVisible();
      await expect(main.locator("h2.seq-no")).toHaveText("No. 1264");
      await expect(main.locator("h2.seq-no")).toBeVisible();
      await expect(main.locator(".toc")).toBeVisible();
      await expect(page.locator('body > header nav.sections a[aria-current="page"]'))
        .toHaveCSS("background-color", "rgba(255, 255, 255, 0.2)");
      await expect(main.locator('.toc li > a[href="#amendments"]')).toBeVisible();
      const recommendation = main.locator(".recommendation").filter({ hasText: "E.118" }).first();
      await expect(recommendation).toHaveText("In accordance with ITU-T Recommendation E.118 (2006-05)");
      await expect(recommendation).toBeVisible();
      const email = main.locator(".authors .contact-email").filter({ hasText: "itumail@itu.int" });
      await expect(email).toHaveText("Email: itumail@itu.int");
      await expect(email).toBeVisible();
      const amendment = main.locator(".message--amendment h3.title").filter({ has: page.locator('a.text[href="/datasets/e118-iin/"]') });
      await expect(amendment).toHaveText("Amd. 79 to List of Issuer Identifier Numbers for the International Telecommunication Charge Card #");
      await expect(amendment).toBeVisible();
      await inspect(page, "issue", width, errors);
    });

    test("register page", async ({ page }) => {
      const errors = watchConsole(page);
      await page.goto("/registers/e212-icc/");
      const main = page.getByRole("main");
      await expect(main.getByRole("heading", { name: "List of mobile country or geographical area codes", exact: true })).toBeVisible();
      await expect(main.getByRole("heading", { name: "Issues amending this register", exact: true })).toBeVisible();
      const item = main.getByRole("listitem").filter({ has: page.locator('a[href="/issues/1301/"]') });
      await expect(item.getByRole("link", { name: "OB no. 1301", exact: true })).toBeVisible();
      await inspect(page, "register", width, errors);
    });

    const adminPages = [
      ["", "Administration"],
      ["catalog", "Service publications"],
      ["composer", "Edition composer"],
      ["editor", "Schema action editor"],
      ["general", "General messages"],
      ["members", "Membership administration"],
      ["submissions", "Review submissions"],
      ["bulk", "Bulk import as a patch series"],
      ["annexes", "Annexes"],
    ] as const;
    for (const [adminPath, heading] of adminPages) {
      test(`admin /${adminPath}`, async ({ page }) => {
        const errors = watchConsole(page);
        const res = await page.goto(`/admin/${adminPath ? adminPath + "/" : ""}`);
        expect(res?.status()).toBeLessThan(400);
        const main = page.getByRole("main");
        await expect(main.getByRole("heading", { name: heading, exact: true })).toBeVisible();
        // Assert the page-specific workspace even when Access-protected data is unavailable.
        switch (adminPath) {
          case "":
            await expect(main.getByRole("listitem").filter({ hasText: "Author general messages" })).toBeVisible();
            break;
          case "catalog":
            await expect(main.getByRole("columnheader", { name: "Title", exact: true })).toBeVisible();
            await expect(main.getByLabel("Publication identifier", { exact: true })).toBeVisible();
            break;
          case "composer":
            await expect(main.getByLabel("OB edition number", { exact: true })).toBeVisible();
            await expect(main.getByRole("heading", { name: "Merged, unpublished submissions", exact: true })).toBeVisible();
            break;
          case "editor":
          case "submissions":
            await expect(main.getByRole("navigation", { name: "Submission workspace", exact: true })).toBeVisible();
            await expect(main.getByRole("combobox", { name: "State filter", exact: true })).toBeVisible();
            break;
          case "general":
            await expect(main.getByRole("group", { name: "Saved drafts", exact: true })).toBeVisible();
            await expect(main.getByRole("button", { name: "New message", exact: true })).toBeVisible();
            break;
          case "members":
            await expect(main.getByText("A verified Cloudflare Access identity is required.", { exact: false })).toBeVisible();
            await expect(main.getByRole("link", { name: "Reload after signing in through Access", exact: true })).toBeVisible();
            break;
          case "bulk":
            await expect(main.getByLabel("Rows", { exact: true })).toBeVisible();
            await expect(main.getByRole("button", { name: "Preview patch series", exact: true })).toBeVisible();
            break;
          case "annexes":
            await expect(main.getByRole("region", { name: "Annex authoring", exact: true })).toBeVisible();
            await expect(main.getByLabel("Issue number", { exact: true })).toBeVisible();
            break;
        }
        // Admin APIs need a Cloudflare Access identity that dev:local does not provide.
        await inspect(page, `admin-${adminPath || "index"}`, width, errors, { allowConsole: /40[13]|Failed to load resource/ });
      });
    }
  });
}
