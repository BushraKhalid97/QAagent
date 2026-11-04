"use strict";
/**
 * Custom business test cases ("use cases") written in plain JSON — no code.
 *
 * {
 *   "scenarios": [
 *     { "name": "Manager can open the CO2 report",
 *       "accounts": ["manager@example.com"],          // optional: only run for these logins
 *       "allowHttp": [403],                           // optional: HTTP errors that are EXPECTED in this case
 *       "steps": [
 *         { "goto": "/reports" },
 *         { "click": "Idling Fuel" },                   // visible text, or a CSS/Playwright selector
 *         { "fill": "input[type=search]", "value": "Van" },
 *         { "select": "select", "value": "Bus" },
 *         { "press": "Enter" },
 *         { "wait": 500 },
 *         { "expectUrl": "/reports/idling-fuel" },
 *         { "expectText": "Idling Fuel" },
 *         { "expectNoText": "Error" },
 *         { "expectVisible": "table" },
 *         { "expectNotVisible": "a[href='/admin']" },
 *         { "expectCount": "table tbody tr", "min": 1 },
 *         { "screenshot": "after-filter" }
 *       ] }
 *   ]
 * }
 */
const fs = require("fs");

function loadScenarios(files) {
  const all = [];
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    for (const s of j.scenarios || []) all.push({ ...s, file: f });
  }
  return all;
}

/** A "click"/"fill" target: CSS/Playwright selector if it looks like one, otherwise visible text. */
function target(page, sel) {
  const isSelector = /^(text=|css=|xpath=|role=|\/\/)/.test(sel) || /[#.\[\]>=:]/.test(sel) ||
    /^(a|button|input|select|textarea|table|form|nav|h[1-6]|li|tr|td|img|label|div|span)\b/.test(sel);
  return isSelector ? page.locator(sel).first() : page.getByText(sel, { exact: false }).first();
}

async function runScenario(page, sc, { baseUrl, timeout, shotAt }) {
  const log = [];
  for (let i = 0; i < sc.steps.length; i++) {
    const st = sc.steps[i];
    const label = `step ${i + 1}: ${JSON.stringify(st)}`;
    try {
      if (st.goto) { await page.goto(new URL(st.goto, baseUrl).toString(), { waitUntil: "domcontentloaded", timeout }); await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {}); }
      else if (st.click) { await target(page, st.click).click({ timeout: 8000 }); await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {}); }
      else if (st.fill) await target(page, st.fill).fill(String(st.value ?? ""), { timeout: 8000 });
      else if (st.select) { await target(page, st.select).selectOption(String(st.value), { timeout: 8000 }); await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {}); }
      else if (st.press) await page.keyboard.press(st.press);
      else if (st.wait) await page.waitForTimeout(+st.wait);
      else if (st.expectUrl) {
        const want = st.expectUrl;
        await page.waitForURL((u) => u.toString().includes(want), { timeout: 8000 });
      } else if (st.expectText) await page.getByText(st.expectText, { exact: false }).first().waitFor({ state: "visible", timeout: 8000 });
      else if (st.expectNoText) {
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
        const loc = page.getByText(st.expectNoText, { exact: false });
        const n = await loc.count();
        for (let k = 0; k < n; k++) if (await loc.nth(k).isVisible()) throw new Error(`text "${st.expectNoText}" is visible`);
      } else if (st.expectNotVisible) {
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
        const loc = page.locator(st.expectNotVisible);
        const n = await loc.count();
        for (let k = 0; k < n; k++) if (await loc.nth(k).isVisible()) throw new Error(`"${st.expectNotVisible}" is visible`);
      } else if (st.expectVisible) await page.locator(st.expectVisible).first().waitFor({ state: "visible", timeout: 8000 });
      else if (st.expectCount) {
        await page.locator(st.expectCount).first().waitFor({ timeout: 8000 }).catch(() => {});
        const n = await page.locator(st.expectCount).count();
        if (st.min !== undefined && n < st.min) throw new Error(`expected at least ${st.min} "${st.expectCount}", found ${n}`);
        if (st.max !== undefined && n > st.max) throw new Error(`expected at most ${st.max} "${st.expectCount}", found ${n}`);
      } else if (st.screenshot) await shotAt(`scenario_${sc.name}_${st.screenshot}`);
      else throw new Error("unknown step type");
      log.push(`✓ ${label}`);
    } catch (e) {
      log.push(`✗ ${label} — ${e.message.split("\n")[0]}`);
      return { status: "fail", message: `Failed at step ${i + 1}: ${e.message.split("\n")[0].slice(0, 200)}`, evidence: log, screenshot: await shotAt(`scenario_fail_${sc.name}`) };
    }
  }
  return { status: "pass", message: `${sc.steps.length} steps passed`, evidence: log };
}

module.exports = { loadScenarios, runScenario };
