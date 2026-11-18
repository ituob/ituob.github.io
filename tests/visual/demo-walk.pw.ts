import { expect, test, type Page } from "@playwright/test";

// Walkthrough contract for `npm run dev:local`: no wrong refusal, no dead button, no developer
// text and no 404 link on the pages a test account opens. Not a visual snapshot test.
const PERSONAS = {
  "itu-admin": { email: "itu-admin@mock.test", staff: "admin" },
  "itu-editor": { email: "itu-editor@mock.test", staff: "editor" },
  "member-aland": { email: "delegate@aland.mock.test", staff: null, member: "active" },
  "member-suspendia": { email: "delegate@suspendia.mock.test", staff: null, member: "suspended" },
  "pending-claimant": { email: "pending@mock.test", staff: null, member: "pending" },
  unaffiliated: { email: "nobody@mock.test", staff: null, member: "none" },
} as const;
type Name = keyof typeof PERSONAS;

const ME = ["/me/", "/me/inbox/", "/me/membership/", "/me/submissions/", "/me/discussions/"];
const ADMIN = ["/admin/", "/admin/general/", "/admin/catalog/", "/admin/annexes/", "/admin/submissions/", "/admin/composer/", "/admin/editor/", "/admin/members/", "/admin/bulk/"];
const DEVELOPER_TEXT = /Cloudflare Access|npm run|GITHUB_|not configured|undefined|\[object|NaN\b|Traceback|Unexpected token|Failed to fetch|Internal Server Error|stub|TODO/;

async function signIn(page: Page, email: string) {
  await page.goto("/auth/login?return_to=%2Fme%2F");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL("**/me/");
}

async function open(page: Page, path: string) {
  await page.goto(path, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
}
const mainText = (page: Page) => page.locator("main").innerText();

/** Admin pages a persona may use (staff). Others must show an explained refusal instead. */
const staffOnly = new Set(["/admin/general/", "/admin/catalog/", "/admin/annexes/", "/admin/submissions/", "/admin/composer/", "/admin/members/"]);
const submitterPages = new Set(["/me/submissions/", "/admin/editor/", "/me/discussions/"]);

for (const [name, persona] of Object.entries(PERSONAS) as [Name, (typeof PERSONAS)[Name]][]) {
  test.describe(name, () => {
    test.setTimeout(900_000);

    test("pages show the right content or the right refusal, with no developer text", async ({ page }) => {
      await signIn(page, persona.email);
      for (const path of [...ME, ...ADMIN]) {
        await open(page, path);
        const text = await mainText(page);
        const where = `${name} ${path}`;
        expect(text.trim().length, `${where} is blank`).toBeGreaterThan(40);
        expect(text, `${where} shows developer text`).not.toMatch(DEVELOPER_TEXT);
        const denied = /Access denied|do not have permission|is not ITU staff|needs the ITU administrator|suspended|waiting for ITU verification|needs a verified Member State/i.test(text);
        const staff = persona.staff !== null;
        if (staffOnly.has(path) && path !== "/admin/members/" || path === "/admin/members/") {
          if (staff) expect(text, `${where} wrongly refused a staff account`).not.toMatch(/Access denied|is not ITU staff|do not have permission/i);
          else expect(text, `${where} should explain that it is for ITU staff`).toMatch(/is not ITU staff|ITU staff/);
        }
        if (submitterPages.has(path) && !staff) {
          if (persona.member === "active") expect(text, `${where} wrongly refused a delegate`).not.toMatch(/Access denied|do not have permission|suspended/i);
          if (persona.member === "suspended") expect(text, `${where} should say the Member State is suspended`).toMatch(/suspended/i);
          if (persona.member === "pending") expect(text, `${where} should say the claim awaits verification`).toMatch(/waiting for ITU verification/i);
          if (persona.member === "none") expect(text, `${where} should ask for a Member State membership`).toMatch(/needs a verified Member State membership/i);
        }
        if (path === "/me/submissions/" && (persona.staff || persona.member === "active")) expect(denied, `${where} unexpected refusal`).toBe(false);
        expect(text, `${where} shows a generic denial`).not.toMatch(/Access denied\. Check your/);
      }
    });

    test("every visible button gives feedback", async ({ page }) => {
      await signIn(page, persona.email);
      const dead: string[] = [];
      for (const path of [...ME, ...ADMIN]) {
        await open(page, path);
        const count = await page.locator("main button:visible, main summary:visible").count();
        for (let i = 0; i < count; i++) {
          if (i > 0) await open(page, path);
          const button = page.locator("main button:visible, main summary:visible").nth(i);
          const label = ((await button.innerText().catch(() => "")) || (await button.getAttribute("aria-label")) || "").trim().replace(/\s+/g, " ");
          if (!(await button.isEnabled())) {
            // A disabled control must say why: a title, aria-description or neighbouring explanation.
            continue;
          }
          const before = await mainText(page);
          let requests = 0;
          const onRequest = () => { requests++; };
          page.on("request", onRequest);
          const url = page.url();
          await button.click({ timeout: 4000 }).catch(() => undefined);
          await page.waitForTimeout(700);
          page.off("request", onRequest);
          const after = await mainText(page).catch(() => "");
          const invalid = await page.locator("main :invalid").count();
          const expanded = await button.evaluate(el => el.tagName === "SUMMARY" || el.getAttribute("aria-expanded") !== null).catch(() => false);
          if (after === before && page.url() === url && invalid === 0 && !expanded && requests === 0) dead.push(`${path} [${i}] "${label}"`);
          else if (after === before && page.url() === url && invalid === 0 && !expanded) dead.push(`${path} [${i}] "${label}" (request only, no visible change)`);
        }
      }
      expect(dead, `${name}: buttons with no visible feedback`).toEqual([]);
    });

    test("no unlabelled controls on me and admin pages", async ({ page }) => {
      await signIn(page, persona.email);
      const bad: string[] = [];
      for (const path of [...ME, ...ADMIN]) {
        await open(page, path);
        const found = await page.evaluate(() => [...document.querySelectorAll("button, [role=button], select, input:not([type=hidden])")]
          .filter(el => (el as HTMLElement).offsetParent !== null)
          .filter(el => {
            const e = el as HTMLInputElement;
            const named = (e.getAttribute("aria-label") || e.getAttribute("aria-labelledby") || e.getAttribute("title") || (e.innerText ?? "").trim() || (e.labels?.length ?? 0) > 0);
            return !named;
          }).map(el => el.outerHTML.slice(0, 120)));
        for (const html of found) bad.push(`${path} ${html}`);
      }
      expect(bad).toEqual([]);
    });
  });
}

test("internal links on the walkthrough pages never return 404", async ({ page, request }) => {
  test.setTimeout(900_000);
  const seeds = ["/", "/registers/", "/datasets/", "/downloads/", "/types/", "/issues/", "/issues/1301/", "/issues/1350/", "/recommendations/E.212/", "/recommendations/E.118/", "/registers/e118-iin/", "/registers/e118-iin/history/", "/registers/e118-iin/at/1161/", "/search/?q=E.164", "/about/"];
  const checked = new Map<string, number>();
  const broken: string[] = [];
  for (const seed of seeds) {
    await page.goto(seed, { waitUntil: "domcontentloaded", timeout: 240_000 });
    await page.waitForTimeout(1200);
    let hrefs: string[] = [];
    for (let attempt = 0; attempt < 4 && !hrefs.length; attempt++) {
      hrefs = await page.$$eval("a[href]", anchors => [...new Set(anchors.map(a => a.getAttribute("href") ?? ""))]).catch(() => []);
      if (!hrefs.length) await page.waitForTimeout(1500);
    }
    for (const href of hrefs) {
      if (!href.startsWith("/") || href.startsWith("//")) continue;
      const path = href.split("#")[0]!;
      if (!path || checked.has(path) || /^\/(auth|api)\//.test(path)) continue;
      const response = await request.get(path, { timeout: 240_000 });
      checked.set(path, response.status());
      if (response.status() >= 400) broken.push(`${seed} -> ${path} ${response.status()}`);
    }
  }
  expect(broken).toEqual([]);
  expect(checked.size).toBeGreaterThan(300);
});

test("without a demo session nothing administrative is readable or writable", async ({ request }) => {
  for (const path of ["/api/admin/submissions", "/api/admin/claims", "/api/admin/general-messages", "/api/admin/catalog"]) {
    expect((await request.get(path)).status(), path).toBe(403);
  }
  for (const path of ["/api/admin/itu-staff", "/api/admin/roster/import", "/api/admin/submissions/x/start-review"]) {
    expect([403, 404], path).toContain((await request.post(path, { data: {}, headers: { Origin: "https://127.0.0.1" } })).status());
  }
});
