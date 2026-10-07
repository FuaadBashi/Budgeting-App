import { expect, test } from "@playwright/test";
import { animationsStarted, DESIGNS, recordAnimations, SCREENS, settle, storeDesign } from "./support";

/**
 * What the motion layer does in a browser, which the static checks on
 * globals.css cannot show: computed styles after real animations have run.
 */

for (const path of ["/", "/budgets"]) {
  test(`a card on ${path} still lifts under the cursor once its entrance has played`, async ({ page, context }) => {
    // A `forwards` fill once held each card's last keyframe for good, and an
    // animated value outranks the hover rule, so cards silently stopped
    // lifting. Nothing looked broken; the effect was simply gone.
    await storeDesign(context, "noir");
    await page.goto(path);
    const card = page.locator(".stagger-in.card, .stagger-in.severity-accent").first();
    await expect(card).toBeVisible();
    await settle(page);

    await card.hover();
    await settle(page);

    expect(await card.evaluate((el) => getComputedStyle(el).transform)).toBe("matrix(1, 0, 0, 1, 0, -3)");
  });
}

test.describe("with reduced motion requested", () => {
  test.use({ reducedMotion: "reduce" });

  for (const design of DESIGNS) {
    test(`nothing animates in ${design} on any screen`, async ({ page, context }) => {
      await storeDesign(context, design);
      await recordAnimations(context);

      const moved: string[] = [];
      for (const path of SCREENS) {
        await page.goto(path, { waitUntil: "networkidle" });
        const names = await animationsStarted(page);
        if (names.length) moved.push(`${path}: ${[...new Set(names)].join(", ")}`);
      }

      expect(moved).toEqual([]);
    });
  }
});

for (const design of DESIGNS) {
  test(`${design} does animate when motion is allowed, so the check above can fail`, async ({ page, context }) => {
    await storeDesign(context, design);
    await recordAnimations(context);
    await page.goto("/", { waitUntil: "networkidle" });

    expect((await animationsStarted(page)).length).toBeGreaterThan(0);
  });
}

test("the entrance starts from the server's HTML, before any of the app's JavaScript runs", async ({ page, context }) => {
  // The page used to paint whole, then snap back to hidden once hydration set
  // the design attribute and the motion rules first matched. With the app's
  // scripts blocked, only the server's HTML and CSS are left to start it.
  await recordAnimations(context);
  await context.route("**/_next/static/**/*.js", (route) => route.abort());
  await page.goto("/analytics", { waitUntil: "load" });

  await expect.poll(() => animationsStarted(page).then((names) => names.length)).toBeGreaterThan(0);
  await expect(page.locator("html")).toHaveAttribute("data-design", "noir");
});
