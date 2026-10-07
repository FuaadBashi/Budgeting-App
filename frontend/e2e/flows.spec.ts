import { expect, test, type APIRequestContext } from "@playwright/test";
import { formatMinor } from "../src/lib/money";

/**
 * Whole journeys through the real stack. Each asserts a change against the
 * figure before it, never a fixed number: the seed dates everything from
 * today, so absolute balances differ from one day to the next.
 */

interface Named {
  id: string;
  name: string;
}

async function balanceOf(request: APIRequestContext, name: string): Promise<number> {
  const accounts: (Named & { balance_minor: number })[] = await (await request.get("/api/accounts")).json();
  return accounts.find((a) => a.name === name)!.balance_minor;
}

async function renameCategory(request: APIRequestContext, from: string, to: string) {
  const categories: Named[] = await (await request.get("/api/categories")).json();
  const category = categories.find((c) => c.name === from);
  if (category) await request.patch(`/api/categories/${category.id}`, { data: { name: to } });
}

test("a spend recorded in the form comes off the account it was paid from", async ({ page, request }) => {
  const before = await balanceOf(request, "Current");

  await page.goto("/");
  await page.getByRole("button", { name: /^Add$/ }).filter({ visible: true }).first().click();
  const form = page.getByRole("dialog");
  await form.locator('input[name="amount"]').fill("18.40");
  await form.locator('select[name="source_account_id"]').selectOption({ label: "Current" });
  await form.locator('select[name="destination_account_id"]').selectOption({ label: "Eating Out" });
  await form.locator('select[name="category_id"]').selectOption({ label: "Restaurants · discretionary" });
  await form.locator('input[name="description"]').fill("Lunch, recorded by the browser test");
  await form.getByRole("button", { name: "Record transaction" }).click();
  await expect(form).toBeHidden();

  // The ledger moved by exactly the amount typed: pounds became pence once.
  const after = before - 1840;
  expect(await balanceOf(request, "Current")).toBe(after);

  await page.goto("/accounts");
  await expect(page.getByText(formatMinor(after), { exact: true }).first()).toBeVisible();
  await page.goto("/transactions");
  await expect(page.getByText("Lunch, recorded by the browser test").first()).toBeVisible();
});

test("renaming a category relabels its past spending in Analytics", async ({ page, request }) => {
  // Every seeded month, plus a margin either side for a runner whose date is
  // a day off the server's at a month boundary.
  const now = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const start = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 8, 1)));
  const end = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)));
  const spending = () =>
    page.locator("div", { has: page.getByRole("heading", { name: "Spending by category" }) }).last();

  try {
    await page.goto(`/analytics?start=${start}&end=${end}`);
    await expect(spending().getByText("Restaurants", { exact: true })).toBeVisible();

    await page.goto("/accounts?tab=categories");
    await page.getByRole("button", { name: "Rename Restaurants" }).click();
    await page.getByLabel("New name for Restaurants").fill("Dining out");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Rename Dining out" })).toBeVisible();

    await page.goto(`/analytics?start=${start}&end=${end}`);
    await expect(spending().getByText("Dining out", { exact: true })).toBeVisible();
    await expect(spending().getByText("Restaurants", { exact: true })).toHaveCount(0);
  } finally {
    await renameCategory(request, "Dining out", "Restaurants");
  }
});
