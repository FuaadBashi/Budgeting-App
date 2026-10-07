import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

test("the server paints the same design and appearance DesignProvider starts from", () => {
  // The layout cannot import the defaults: lib/design.tsx is a client module,
  // and a server component gets a reference to its exports, not their values.
  // So the two are written twice, and if they drift the first paint shows one
  // design and hydration swaps in another.
  const design = read("lib/design.tsx");
  const layout = read("app/layout.tsx");
  const defaultDesign = design.match(/const DEFAULT_DESIGN: Design = "(\w+)"/)?.[1];
  const defaultAppearance = design.match(/const DEFAULT_APPEARANCE: Appearance = "(\w+)"/)?.[1];

  assert.ok(defaultDesign && defaultAppearance, "the defaults moved; update this test");
  assert.match(layout, new RegExp(`data-design="${defaultDesign}"`));
  assert.match(layout, new RegExp(`data-theme="${defaultAppearance}"`));
});
