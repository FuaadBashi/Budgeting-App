import { expect, test } from "@playwright/test";
import { APPEARANCES, DESIGNS, SCREENS, storeDesign } from "./support";

/**
 * Sweeps of every screen in every design. The token test checks each
 * palette's pairs on paper; this checks the text as it actually renders, on
 * whatever surface it actually landed on, including inline colours that never
 * pass through a token.
 */

/**
 * Every visible text element whose contrast with the background behind it is
 * under WCAG AA: 4.5:1, or 3:1 for large text.
 *
 * Colours are read back through a canvas, which resolves every CSS colour
 * syntax the designs use (oklab, color-mix, hex with alpha) to sRGB bytes.
 * Translucent backgrounds are composited up the ancestor chain to the page.
 */
function lowContrastText(): string[] {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  type Rgba = [number, number, number, number];
  const rgba = (css: string): Rgba => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const over = (top: Rgba, base: Rgba): Rgba => {
    const a = top[3];
    return [0, 1, 2].map((i) => top[i] * a + base[i] * (1 - a)).concat(1) as Rgba;
  };
  const luminance = ([r, g, b]: Rgba) => {
    const f = (byte: number) => {
      const c = byte / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a: Rgba, b: Rgba) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const backgroundOf = (el: Element): Rgba => {
    const layers: Rgba[] = [];
    for (let n: Element | null = el; n; n = n.parentElement) {
      const c = rgba(getComputedStyle(n).backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 1) break;
    }
    let base = rgba(getComputedStyle(document.body).backgroundColor);
    if (base[3] < 1) base = [255, 255, 255, 1];
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return base;
  };

  const failures: string[] = [];
  const seen = new Set<Element>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const el = walker.currentNode.parentElement;
    const content = walker.currentNode.textContent?.trim();
    if (!el || !content || seen.has(el)) continue;
    if (el.closest('svg, [aria-hidden="true"], option, script, style, [disabled]')) continue;
    seen.add(el);
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height || style.visibility === "hidden" || Number(style.opacity) === 0) continue;

    const background = backgroundOf(el);
    const size = parseFloat(style.fontSize);
    const large = size >= 24 || (parseInt(style.fontWeight) >= 700 && size >= 18.66);
    const needed = large ? 3 : 4.5;
    const got = ratio(over(rgba(style.color), background), background);
    if (got < needed) failures.push(`${got.toFixed(2)} < ${needed}: "${content.slice(0, 40)}"`);
  }
  return failures;
}

test.describe("text contrast", () => {
  // Mid-entrance text is partly transparent and would fail for a moment.
  test.use({ reducedMotion: "reduce" });

  for (const design of DESIGNS) {
    for (const appearance of APPEARANCES) {
      test(`every screen's text meets AA in ${design}, ${appearance}`, async ({ page, context }) => {
        await storeDesign(context, design, appearance);

        const failures: string[] = [];
        for (const path of SCREENS) {
          await page.goto(path, { waitUntil: "networkidle" });
          for (const failure of new Set(await page.evaluate(lowContrastText))) failures.push(`${path} ${failure}`);
        }

        expect(failures).toEqual([]);
      });
    }
  }
});

test.describe("on a phone", () => {
  // Not `isMobile`: a mobile viewport zooms out to fit a page that is too
  // wide, which hides the very overflow this is looking for.
  test.use({ viewport: { width: 390, height: 844 } });

  for (const design of DESIGNS) {
    test(`no screen scrolls sideways in ${design}`, async ({ page, context }) => {
      await storeDesign(context, design);

      const wide: string[] = [];
      for (const path of SCREENS) {
        await page.goto(path, { waitUntil: "networkidle" });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) wide.push(`${path} is ${overflow}px too wide`);
      }

      expect(wide).toEqual([]);
    });
  }
});
