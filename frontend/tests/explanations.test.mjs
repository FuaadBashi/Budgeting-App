import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Test the pure presentation builders without a browser or a running database.
function load(name) {
  const source = readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports = {};
  vm.runInNewContext(js, { exports, require: path => {
    assert.equal(path, "./money");
    return load("money");
  } });
  return exports;
}
const helpers = load("metric-explanations");
const { SCREEN_GUIDES, FIELD_HELP } = load("explanations");
const sts = { cash_minor: 9340, safe_to_spend_minor: -40660, window_end: "2026-10-31",
  breakdown: [["Liquid cash", 9340], ["Committed before next income", 0], ["Protected buffer", 0], ["Planned contributions still owed", -50000]] };

test("all eleven main screens have meaningful help", () => {
  for (const route of ["dashboard", "transactions", "accounts", "analytics", "insights", "budgets", "calendar", "goals", "simulator", "import", "data"]) {
    assert.ok(SCREEN_GUIDES[route].items.length >= 5, route);
    assert.ok(SCREEN_GUIDES[route].items.every(([label, text]) => label && text.length > 30));
  }
  assert.match(FIELD_HELP["Opening balance"], /must not be deducted again/);
});
test("safe-to-spend explanation preserves signed API terms and does not fabricate cash", () => {
  const out = helpers.safeExplanation(sts, null);
  assert.equal(out.rows.reduce((sum, r) => sum + r.value, 0), sts.safe_to_spend_minor);
  assert.match(out.note, /not necessarily an overdrawn/);
});
test("a mismatched optional trace cannot explain a different displayed total", () => {
  const out = helpers.safeExplanation(sts, { total_minor: 900000, terms: [{ label: "Wrong snapshot", amount_minor: 900000, parts: [] }] });
  assert.equal(out.rows[0].label, "Liquid cash");
  assert.equal(out.rows[0].value, 9340);
});
test("matching traces retain nested account and goal evidence", () => {
  const out = helpers.safeExplanation(sts, { total_minor: -40660, terms: [
    { label: "Liquid cash", amount_minor: 9340, detail: "cash", parts: [{ label: "Bank", amount_minor: 6180, parts: [] }] },
  ] });
  assert.equal(out.rows[0].parts[0].value, 6180);
});
test("daily help excludes unavailable periods and explains the minimum, not a sum", () => {
  const out = helpers.dailyExplanation([{ budget_name: "Food", presented_allowance_minor: 0, days_remaining: 28, binding_constraint: "safe_to_spend" },
    { budget_name: "Closed", presented_allowance_minor: null }]);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].value, 0);
  assert.match(out.formula, /do not add/);
  assert.match(helpers.dailyExplanation([]).note, /not unlimited/);
});
test("savings explanation exposes the protected shortfall rather than promising affordability", () => {
  const out = helpers.savingsExplanation({ planned_total_minor: 50000, already_contributed_minor: 0,
    horizon: "2026-09-30", recovery_impossible: true, protected_shortfall_minor: 10660,
    flexible_sacrificed: [{ goal_name: "Driving", sacrificed_minor: 15000 }, { goal_name: "Long-term", sacrificed_minor: 15000 }] });
  assert.equal(out.rows.reduce((sum, r) => sum + r.value, 0), 20000);
  assert.match(out.note, /£106.60/);
  assert.match(out.note, /not an affordable saving amount/);
});
test("missing recovery and net-worth detail remain explicit, not invented", () => {
  assert.match(helpers.savingsExplanation(null).note, /unavailable/);
  assert.equal(helpers.netWorthExplanation(9340, { total_minor: 0 }).rows, undefined);
});
