import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
  await page.clock.setFixedTime(new Date("2026-08-03T12:00:00.000Z"));
});

test("CRM generated content and complete Meridian scenario match the pinned baseline", async ({
  page,
}) => {
  await page.goto("/a/crm/opportunity", { waitUntil: "networkidle" });

  await expect(page.getByRole("heading", { name: "Opportunities" })).toBeVisible();
  await expect(page.getByText("Meridian Logistics").first()).toBeVisible();
  await expect(page.getByText("Pending change", { exact: true })).toBeVisible();
  await expect(page.getByText("SF: j.keller")).toBeVisible();
  await expect(page.getByText("Unlinked", { exact: true })).toBeVisible();
  await expect(page.getByText("Approval needed", { exact: true })).toBeVisible();
  await expect(page.getByText("Activity — call with Dana Okafor logged · auto per rule")).toBeVisible();
  await expect(page.locator(".records-ask input")).toHaveAttribute(
    "placeholder",
    "Find, compare, or change a record…",
  );

  await expect(page.locator(".records-list-main")).toHaveScreenshot(
    "crm-generated-content.png",
  );
  await expect(page).toHaveScreenshot("crm-complete-scenario.png", {
    fullPage: true,
  });
});

test("non-CRM adversarial fixture stays generic and visually stable", async ({ page }) => {
  await page.goto("/a/support_lab/support_case", { waitUntil: "networkidle" });

  await expect(
    page.getByRole("heading", {
      name: "Customer support requests requiring coordinated investigation across fulfillment, billing, and field service teams",
    }),
  ).toBeVisible();
  await expect(page.getByText("waiting_on_vendor")).toBeVisible();
  await expect(page.locator(".records-null")).toContainText("—");
  await expect(page.getByText("+2")).toBeVisible();
  await expect(page.getByText("Owner", { exact: true })).toHaveCount(0);
  await expect(page.getByText("INTERNAL ONLY")).toHaveCount(0);
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);

  await expect(page.locator(".records-list-main")).toHaveScreenshot(
    "support-adversarial-generated-content.png",
  );
  const tableScroll = page.locator(".records-table-scroll");
  await tableScroll.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect(page.locator(".records-list-card")).toHaveScreenshot(
    "support-adversarial-table-tail.png",
  );
});
