import type { BrowserContext, Page } from "@playwright/test";

/** Every screen, by path. The categories tab renders its own list, so it counts. */
export const SCREENS = [
  "/",
  "/transactions",
  "/accounts",
  "/accounts?tab=categories",
  "/analytics",
  "/insights",
  "/budgets",
  "/calendar",
  "/goals",
  "/simulator",
  "/import",
  "/data",
];

export const DESIGNS = ["noir", "field", "raw", "console"] as const;
export const APPEARANCES = ["light", "dark"] as const;

/** Open every page in a design, the way a returning visitor's stored choice does. */
export async function storeDesign(context: BrowserContext, design: string, appearance = "dark") {
  await context.addInitScript(
    ([d, a]) => {
      localStorage.setItem("pfos:design", d);
      localStorage.setItem("pfos:appearance", a);
    },
    [design, appearance],
  );
}

/**
 * Record the name of every CSS animation that starts, from the first frame.
 *
 * Listening rather than asking `document.getAnimations()` afterwards: an
 * entrance that has already finished is no longer listed, so a check made
 * after the page settles would miss exactly the short ones.
 */
export async function recordAnimations(context: BrowserContext) {
  await context.addInitScript(() => {
    const started: string[] = [];
    Object.assign(window, { __animationsStarted: started });
    document.addEventListener("animationstart", (event) => started.push(event.animationName), true);
  });
}

export function animationsStarted(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __animationsStarted: string[] }).__animationsStarted);
}

/** Wait until every animation that will end has ended. Ambient loops never do. */
export async function settle(page: Page) {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
      .every((a) => a.playState !== "running"),
  );
}
