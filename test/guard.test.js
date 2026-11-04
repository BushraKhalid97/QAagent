"use strict";
/** Safety-rail tests for the AI tester's click guard.  Run: node test/guard.test.js */
const assert = require("assert");
const { guard } = require("../ai/executor");

const TAG = "QATEST1";
const el = (label, { row = "", form = null, inRow = !!row, inDialog = false, dialogText = "", isLink = false } = {}) => ({
  label, title: "", isLink, inRow, inDialog, dialogText,
  containers: [...(row ? [{ text: row, hasInputs: false, filled: false }] : []), ...(form ? [form] : [])],
});
const full = { tag: TAG, allowMutation: true, armed: false };
const safe = { tag: TAG, allowMutation: false, armed: false };
const cases = [
  ["delete own record", el("Delete", { row: `${TAG} Reefer Van 2.5 L/h` }), full, true],
  ["delete existing record", el("Delete", { row: "Van 1.8 L/h" }), full, false],
  ["edit existing record in row", el("Edit", { row: "Van 1.8 L/h" }), full, false],
  ["edit own record in row", el("Edit", { row: `${TAG} Van` }), full, true],
  ["logout", el("Sign out"), full, false],
  ["logout icon by tooltip", { ...el("⎋"), title: "Log out" }, full, false],
  ["save form with tag", el("Save", { form: { text: `Name ${TAG} Van`, hasInputs: true, filled: true } }), full, true],
  ["save form editing untagged record", el("Update type", { form: { text: "Name Van 1.8", hasInputs: true, filled: true } }), full, false],
  ["submit empty form (validation test)", el("Add type", { form: { text: "", hasInputs: true, filled: false } }), full, true],
  ["confirm dialog right after approved delete", el("Yes", { inDialog: true, dialogText: "Are you sure?" }), { ...full, armed: true }, true],
  ["confirm dialog without approved action", el("Yes", { inDialog: true, dialogText: "Are you sure?" }), full, false],
  ["confirm dialog naming own record", el("Delete", { inDialog: true, dialogText: `Delete ${TAG} Van?` }), full, true],
  ["reset all data button", el("Reset to sample data"), full, false],
  ["navigation link", el("Reports", { isLink: true }), full, true],
  ["plain filter button", el("Apply filters"), full, true],
  ["reset filters (found in real run)", el("↺ Reset filters"), full, true],
  ["reset filters in safe mode", el("Reset filters"), safe, true],
  ["clear search", el("Clear search"), full, true],
  ["cancel button", el("Cancel"), full, true],
  ["reset password is NOT view-only", el("Reset password", { row: "admin@iotcube.ai" }), full, false],
  ["safe mode delete own record", el("Delete", { row: `${TAG} Van` }), safe, false],
  ["safe mode save (network guard blocks it)", el("Save", { form: { text: `${TAG}`, hasInputs: true, filled: true } }), safe, true],
];
let failed = 0;
for (const [name, info, opts, expected] of cases) {
  const r = guard(info, opts);
  const ok = r.allow === expected;
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name}: ${r.allow ? "allowed" : "refused"}${r.reason ? ` (${r.reason.slice(0, 60)}…)` : ""}`);
}
assert.strictEqual(failed, 0, `${failed} guard case(s) failed`);
console.log(`\nAll ${cases.length} guard cases passed.`);
