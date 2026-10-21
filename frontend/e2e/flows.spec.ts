import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
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
  // Simple entry is the default; this flow names both ledger accounts, which only the full form does.
  await form.getByRole("button", { name: "Advanced / split payment" }).click();
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

test("a purchase saved in simple entry comes off the account it was paid from", async ({ page, request }) => {
  const before = await balanceOf(request, "Current");

  await page.goto("/");
  await page.getByRole("button", { name: /^Add$/ }).filter({ visible: true }).first().click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Product / name").fill("Snacks, recorded by simple entry");
  await form.getByLabel("Amount (£)").fill("7.25");
  await form.getByLabel("Account / from").selectOption({ label: "Current" });
  // The preview is the promise the form makes; the ledger must keep it.
  await expect(form.getByRole("status")).toContainText(`Current: ${formatMinor(before)} → ${formatMinor(before - 725)}`);
  await form.getByRole("button", { name: "Save transaction" }).click();
  await expect(form).toBeHidden();

  expect(await balanceOf(request, "Current")).toBe(before - 725);
});

test("a pending purchase leaves balances alone until it is marked paid", async ({ page, request }) => {
  const before = await balanceOf(request, "Current");
  const open = async () => {
    await page.goto("/");
    await page.getByRole("button", { name: /^Add$/ }).filter({ visible: true }).first().click();
    return page.getByRole("dialog");
  };

  let form = await open();
  await form.getByLabel("Product / name").fill("Pending order, recorded by simple entry");
  await form.getByLabel("Amount (£)").fill("12.00");
  await form.getByLabel("Account / from").selectOption({ label: "Current" });
  await form.getByLabel("Status").selectOption("candidate");
  await form.getByRole("button", { name: "Save transaction" }).click();
  await expect(form).toBeHidden();
  expect(await balanceOf(request, "Current")).toBe(before);

  form = await open();
  await form.getByRole("combobox", { name: "Action", exact: true }).selectOption("settle");
  const pending = form.getByLabel("Pending entry");
  // Option labels carry the date and amount too, so pick by the row's own value.
  const option = pending.locator("option", { hasText: "Pending order, recorded by simple entry" });
  await pending.selectOption((await option.getAttribute("value"))!);
  await form.getByRole("button", { name: "Mark paid / received" }).click();
  await expect(form).toBeHidden();
  expect(await balanceOf(request, "Current")).toBe(before - 1200);
});

async function openSimpleEntry(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /^Add$/ }).filter({ visible: true }).first().click();
  return page.getByRole("dialog");
}

// Labels wrap their selects, so a label's text includes every option; the
// accessible name does not.
const field = (form: Locator, name: string) => form.getByRole("combobox", { name, exact: true });

test("a transfer in simple entry moves money between accounts without changing the total", async ({ page, request }) => {
  const current = await balanceOf(request, "Current");
  const saved = await balanceOf(request, "Emergency Fund");

  const form = await openSimpleEntry(page);
  await field(form, "Transaction type").selectOption("transfer");
  await form.getByLabel("Product / name").fill("Top up savings, recorded by simple entry");
  await form.getByLabel("Amount (£)").fill("50.00");
  await field(form, "Account / from").selectOption({ label: "Current" });
  await field(form, "To account").selectOption({ label: "Emergency Fund" });
  await expect(form.getByRole("status")).toContainText(`Emergency Fund: ${formatMinor(saved)} → ${formatMinor(saved + 5000)}`);
  await form.getByRole("button", { name: "Save transaction" }).click();
  await expect(form).toBeHidden();

  expect(await balanceOf(request, "Current")).toBe(current - 5000);
  expect(await balanceOf(request, "Emergency Fund")).toBe(saved + 5000);
});

test("a refund returns money once, and refunding more than is left is refused", async ({ page, request }) => {
  const accounts: Named[] = await (await request.get("/api/accounts")).json();
  const id = (name: string) => accounts.find((a) => a.name === name)!.id;
  // Yesterday, so the purchase is in balances whatever the runner's timezone.
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const purchase = "Faulty kettle, bought for the refund test";
  await request.post("/api/transactions", {
    data: {
      booking_date: yesterday,
      description: purchase,
      postings: [
        { account_id: id("Current"), amount_minor: -3000 },
        { account_id: id("Eating Out"), amount_minor: 3000 },
      ],
    },
  });
  const before = await balanceOf(request, "Current");

  const refund = async (amount: string) => {
    const form = await openSimpleEntry(page);
    await field(form, "Transaction type").selectOption("refund");
    await form.getByLabel("Product / name").fill(`Kettle refund ${amount}`);
    await form.getByLabel("Amount (£)").fill(amount);
    await field(form, "Receive into account").selectOption({ label: "Current" });
    const original = field(form, "Original purchase");
    await original.selectOption((await original.locator("option", { hasText: purchase }).getAttribute("value"))!);
    await form.getByRole("button", { name: "Save transaction" }).click();
    return form;
  };

  await expect(await refund("12.00")).toBeHidden();
  expect(await balanceOf(request, "Current")).toBe(before + 1200);

  // £18 is left to refund; the server must refuse £25 and the form must say so.
  const form = await refund("25.00");
  await expect(form.getByRole("alert")).toContainText("Refund exceeds");
  expect(await balanceOf(request, "Current")).toBe(before + 1200);
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
