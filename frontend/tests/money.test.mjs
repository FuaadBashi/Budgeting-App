import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function loadMoney() {
  const source = readFileSync(new URL("../src/lib/money.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports = {};
  vm.runInNewContext(js, { exports, Intl });
  return exports;
}
const { formatMinorForInput, parseMajorToMinor } = loadMoney();

test("an amount pre-filled into an input reads back as the same pence", () => {
  // Saving a form without editing it must not move the amount by a penny.
  for (const minor of [0, 5, 99, 100, 12345, 25000, 9007199254740991]) {
    assert.equal(parseMajorToMinor(formatMinorForInput(minor)), minor, String(minor));
  }
});

test("pre-filled amounts always show two decimal places", () => {
  assert.equal(formatMinorForInput(0), "0.00");
  assert.equal(formatMinorForInput(5), "0.05");
  assert.equal(formatMinorForInput(25000), "250.00");
  assert.equal(formatMinorForInput(12345), "123.45");
});
