import { expect, test } from "@playwright/test";

// /admin/notifications against dev:local, which has no Access identity: the stats API is mocked
// at the network layer so the page's rendering of real response numbers is what is asserted.
const today = new Date().toISOString().slice(0, 10);
const stats = {
  ok: true, since: today,
  days: { [today]: { sent: 7, bounced: 2, complained: 1 } },
  totals: { sent: 7, bounced: 2, complained: 1 },
  suppressions: { hard_bounce: 2, complaint: 1 },
  recentSuppressions: [{ email: "gone@example.test", reason: "hard_bounce", first_seen: `${today}T00:00:00Z`, detail: "mailbox does not exist" }],
  notificationStatus: { sent: 4, bounced: 2, complained: 1 },
};

test("admin /notifications shows counters and suppressions from the stats API", async ({ page }) => {
  await page.route("**/api/admin/notifications/stats", (route) => route.fulfill({ json: stats }));
  const res = await page.goto("/admin/notifications/");
  expect(res?.status()).toBeLessThan(400);
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "Email delivery", exact: true })).toBeVisible();
  await expect(main.locator('[data-metric="sent"]')).toHaveText("7");
  await expect(main.locator('[data-metric="bounced"]')).toHaveText("2");
  await expect(main.locator('[data-metric="complained"]')).toHaveText("1");
  await expect(main.getByTestId("suppression-counts")).toContainText("Hard bounces: 2 · Complaints: 1");
  await expect(main.getByRole("cell", { name: "gone@example.test" })).toBeVisible();
});

test("admin /notifications reports a missing Access identity instead of failing silently", async ({ page }) => {
  await page.route("**/api/admin/notifications/stats", (route) => route.fulfill({ status: 403, json: { error: "forbidden" } }));
  await page.goto("/admin/notifications/");
  await expect(page.getByRole("alert")).toContainText("permission");
});
