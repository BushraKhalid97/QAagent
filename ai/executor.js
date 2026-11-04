"use strict";
/**
 * Phase 3 — EXECUTE. Claude runs one test case like a manual tester: it reads
 * the current screen, performs one action at a time through the tools below,
 * observes the result, and finally calls `finish` with a verdict and evidence.
 *
 * SAFETY RAILS (enforced in code, not just asked of the model):
 *  - Delete / edit / save-type actions are only allowed on records whose row,
 *    card, form or dialog contains this run's unique tag (i.e. data the test
 *    created). Everything else is refused and the tester is told why.
 *  - Log-out / sign-out is never clicked.
 *  - Native "Are you sure?" dialogs are confirmed only right after an approved action.
 *  - Network guard: a POST/PUT/PATCH/DELETE is let through only if it carries the
 *    run tag or follows an approved action within a few seconds.
 *  - In SAFE mode every data-changing request is blocked.
 */
const { snapshot } = require("./snapshot");
const { sleep, pathOf } = require("../lib/util");

const DESTRUCTIVE = /\b(delete|remove|destroy|purge|reset|clear all|erase|revoke|terminate|archive|deactivate|disable|ban|block)\b/i;
const MODIFY = /\b(edit|update|modify|rename|change|save|submit|confirm|apply|yes|ok|approve|reject|cancel order|toggle|enable|activate|assign|move|duplicate|clone|publish|send)\b/i;
const CREATE = /\b(add|create|new|register|invite|post|insert|book|upload|import)\b/i;
const LOGOUT = /\b(log ?out|sign ?out|log off|logoff)\b/i;
const ARM_MS = 15000;

const str = (d) => ({ type: "string", description: d });
const TOOLS = [
  { name: "click", description: "Click an element by its reference from the latest screen description.", input_schema: { type: "object", additionalProperties: false, required: ["ref"], properties: { ref: str("Element reference, e.g. e12") } } },
  { name: "fill", description: "Clear a text field and type text into it.", input_schema: { type: "object", additionalProperties: false, required: ["ref", "text"], properties: { ref: str("Element reference"), text: str("Text to enter (may be empty to clear the field)") } } },
  { name: "select_option", description: "Choose an option in a dropdown by its visible text.", input_schema: { type: "object", additionalProperties: false, required: ["ref", "option"], properties: { ref: str("Dropdown reference"), option: str("Visible option text") } } },
  { name: "set_checked", description: "Tick or untick a checkbox / switch / radio.", input_schema: { type: "object", additionalProperties: false, required: ["ref", "checked"], properties: { ref: str("Element reference"), checked: { type: "boolean" } } } },
  { name: "press_key", description: "Press a keyboard key, e.g. Enter, Escape, Tab.", input_schema: { type: "object", additionalProperties: false, required: ["key"], properties: { key: str("Key name") } } },
  { name: "navigate", description: "Go to a path of this application, e.g. /reports. Use for the starting screen or the browser 'Back' (pass 'back') / 'Refresh' (pass 'refresh').", input_schema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: str("Path such as /orders, or 'back' / 'refresh'") } } },
  { name: "wait", description: "Wait for slow screens (max 5000 ms).", input_schema: { type: "object", additionalProperties: false, required: ["ms"], properties: { ms: { type: "integer" } } } },
  { name: "look", description: "Get a screenshot of the visible screen when the text description is not enough (charts, colours, layout, images).", input_schema: { type: "object", additionalProperties: false, properties: {} } },
  {
    name: "finish",
    description: "End the test case with your verdict. Call exactly once, when every step is done or the test cannot continue.",
    input_schema: {
      type: "object", additionalProperties: false,
      required: ["status", "summary", "expected", "actual", "severity", "cleanedUp"],
      properties: {
        status: { type: "string", enum: ["pass", "fail", "blocked"], description: "pass = every expected result observed; fail = the app behaved wrongly (a defect); blocked = could not be executed (feature absent, safety rail, environment issue)" },
        summary: str("One or two sentences a QA manager can read"),
        expected: str("What should have happened (for fail/blocked)"),
        actual: str("What actually happened (for fail/blocked)"),
        severity: { type: "string", enum: ["none", "minor", "major", "critical"], description: "Defect severity; none for pass/blocked" },
        cleanedUp: { type: "boolean", description: "true if every record this test created has been deleted (or nothing was created)" },
      },
    },
  },
].map((t) => ({ ...t, eager_input_streaming: true }));

const REQUIRED = Object.fromEntries(TOOLS.map((t) => [t.name, t.input_schema.required || []]));

const SYSTEM = `You are an experienced manual QA tester executing one test case in a real web browser on behalf of a QA team.

How you work:
- After every action you receive a fresh text description of the screen: headings, messages, every control with a reference like [e12], and table rows together with the buttons that belong to each row. Always use references from the LATEST description; old references become invalid after each action.
- Do one action at a time and check the result before moving on, like a careful human. Read success/error messages, table contents and field values to verify expected results. Use "look" only when you need to see something visually.
- Follow the test case's intent rather than its exact wording: if a button is labelled slightly differently or a step needs an extra click (e.g. opening a menu or a confirmation dialog), adapt. If an expected result is ambiguous, judge it as a reasonable business user would.
- Data rules: every record you create must contain the run tag in its name/title. You may only edit or delete records containing the run tag. Never touch existing business data, never log out, never change account settings that aren't part of the test. If the system refuses an action for safety reasons, do not try to work around it — continue if possible, otherwise finish as blocked.
- Clean up: before finishing, delete every record you created (if the app allows deletion), and confirm it is gone.

Verdicts:
- pass: every expected result was observed.
- fail: the application did something wrong — wrong data shown, error/crash, an action that should succeed fails, invalid input accepted, a deleted record still visible, etc. Describe expected vs actual precisely, with the exact on-screen text, so a developer can reproduce it.
- blocked: the test could not be executed (the feature isn't there, a precondition can't be met, a safety rule prevented it, the environment is broken).
Do not mark fail for your own mistakes (e.g. clicking the wrong element) — retry instead. Be efficient: stop as soon as you have enough evidence.`;

function fillTag(s, tag) { return String(s).split("{TAG}").join(tag); }

function testCaseText(tc, tag) {
  return [
    `TEST CASE ${tc.id} — ${fillTag(tc.title, tag)}`,
    `Module: ${tc.module} · Journey: ${tc.journey} · Type: ${tc.type} · Priority: ${tc.priority}`,
    `Preconditions: ${fillTag(tc.preconditions, tag)}`,
    `Steps:\n${tc.steps.map((s, i) => `  ${i + 1}. ${fillTag(s, tag)}`).join("\n")}`,
    `Expected results:\n${tc.expectedResults.map((s) => `  - ${fillTag(s, tag)}`).join("\n")}`,
    `Test data: ${fillTag(tc.testData, tag)}`,
  ].join("\n");
}

/** Inspect an element before clicking: label + text of the containers around it (incl. input values). */
async function inspect(loc) {
  return loc.evaluate((el) => {
    const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
    const label = clean(el.getAttribute("aria-label") || el.innerText || el.value || el.title || "");
    const textWithValues = (c) => clean(c.innerText) + " " + [...c.querySelectorAll("input, textarea, select")].map((i) => i.value).join(" ");
    const containers = [];
    let c = el.closest("tr, [role=row], li, article, .card, form, [role=dialog], dialog, section, [class*=item], [class*=row]");
    while (c && containers.length < 3) { containers.push({ text: textWithValues(c), hasInputs: !!c.querySelector("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea"), filled: [...c.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=number]), textarea")].some((i) => i.value.trim()) }); c = c.parentElement && c.parentElement.closest("tr, [role=row], li, article, .card, form, [role=dialog], dialog, section, main"); }
    const dialog = el.closest('[role=dialog], [role=alertdialog], dialog, .modal, [aria-modal=true]');
    const inRow = !!el.closest("tr, [role=row], li");
    return { label, title: el.title || "", containers, inDialog: !!dialog, dialogText: dialog ? textWithValues(dialog) : "", inRow, isLink: el.tagName === "A" && !!el.getAttribute("href") };
  });
}

/** The safety rail for clicks. Returns { allow, reason, arm }. */
function guard(info, { tag, allowMutation, armed }) {
  const label = `${info.label} ${info.title}`;
  if (LOGOUT.test(label)) return { allow: false, reason: "Logging out is not allowed during a test run." };
  const destructive = DESTRUCTIVE.test(label);
  const modify = MODIFY.test(label) && !info.isLink;
  const create = CREATE.test(label) && !info.isLink;
  if (!destructive && !modify && !create) return { allow: true };
  const tagged = info.containers.some((c) => c.text.includes(tag)) || info.dialogText.includes(tag);
  if (!allowMutation && (destructive || (modify && !/cancel|close/i.test(label)))) {
    if (destructive) return { allow: false, reason: "SAFE mode: deleting is disabled for this run." };
    // modify-type buttons are allowed to be clicked in safe mode (e.g. to see validation); requests are blocked by the network guard
    return { allow: true };
  }
  if (destructive || (modify && info.inRow)) {
    if (tagged) return { allow: true, arm: true };
    if (armed && info.inDialog) return { allow: true, arm: true };
    return { allow: false, reason: `Refused: this would change or delete a record that was not created by this test run (no "${tag}" in it). Only records containing "${tag}" may be edited or deleted.` };
  }
  // save / submit / create-type button
  const form = info.containers.find((c) => c.hasInputs);
  // a confirmation popup ("Are you sure? Yes / OK") is only confirmed right after an approved action
  if (info.inDialog && !tagged && !armed && !form) return { allow: false, reason: `Refused: this confirms a dialog that wasn't opened by an approved action on test data (containing "${tag}"). Press Escape or Cancel instead.` };
  if (form && form.filled && !tagged) return { allow: false, reason: `Refused: the form being saved does not contain the run tag "${tag}". Records created or edited by tests must include "${tag}" in their name, and existing records must not be edited.` };
  return { allow: true, arm: true };
}

async function settle(page) {
  await sleep(300);
  await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
  await sleep(200);
}

/**
 * Run one test case. ctx: { llm, page, monitor, origin, baseUrl, tag, allowMutation, maxSteps, shotAt, ensureLoggedIn, log }
 */
async function runTestCase(tc, ctx) {
  const { llm, page, monitor, origin, baseUrl, tag, allowMutation, maxSteps = 40, shotAt, ensureLoggedIn, log = () => {} } = ctx;
  const transcript = [];
  const hardErrors = [];
  let armedUntil = 0;
  let blockedRequests = 0;
  const armed = () => Date.now() < armedUntil;

  // network guard
  const netGuard = (route) => {
    const r = route.request();
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(r.method()) || !r.url().startsWith(origin)) return route.fallback();
    const body = r.postData() || "";
    const isReadOnlyQuery = /"query"\s*:\s*"\s*(query|\{)/.test(body) && !/mutation/.test(body);
    if ((ctx.isRelogging && ctx.isRelogging()) || isReadOnlyQuery) return route.fallback();
    if (allowMutation && (armed() || body.includes(tag) || decodeURIComponent(r.url()).includes(tag))) return route.fallback();
    blockedRequests++;
    monitor.blockedUrls.add(r.method() + " " + r.url());
    return route.abort("blockedbyclient");
  };
  await page.route("**/*", netGuard);
  monitor.dialogPolicy = () => (allowMutation && armed() ? "accept" : "dismiss");

  const start = Date.now();
  let verdict = null;
  try {
    await ensureLoggedIn();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await settle(page);
    const first = await snapshot(page);
    const messages = [{
      role: "user",
      content: `${testCaseText(tc, tag)}\n\nRUN TAG: ${tag}  (include it in every record you create; only records containing it may be edited or deleted)\nMODE: ${allowMutation ? "FULL — you may create, edit and delete records that contain the run tag" : "SAFE — data cannot be changed in this run; requests that would save data are blocked"}\nYou have at most ${maxSteps} actions.\n\nCURRENT SCREEN:\n${first.text}`,
    }];
    let steps = 0;
    while (!verdict) {
      const msg = await llm.create({ system: SYSTEM, tools: TOOLS, messages, max_tokens: 16000 });
      messages.push({ role: "assistant", content: msg.content });
      const calls = msg.content.filter((b) => b.type === "tool_use");
      if (!calls.length) {
        if (msg.stop_reason === "max_tokens" || steps >= maxSteps) { verdict = { status: "blocked", summary: "Tester stopped without a verdict.", expected: "", actual: "", severity: "none", cleanedUp: false }; break; }
        messages.push({ role: "user", content: "Continue the test using the tools. When done, call finish with your verdict." });
        continue;
      }
      const results = [];
      for (const call of calls) {
        const input = call.input || {};
        const missing = (REQUIRED[call.name] || []).filter((k) => input[k] === undefined);
        if (!REQUIRED[call.name] || missing.length) {
          results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: `INVALID_INPUT: ${!REQUIRED[call.name] ? "unknown tool" : "missing " + missing.join(", ")}` });
          continue;
        }
        if (call.name === "finish") {
          verdict = input;
          results.push({ type: "tool_result", tool_use_id: call.id, content: "Verdict recorded." });
          continue;
        }
        if (verdict) { results.push({ type: "tool_result", tool_use_id: call.id, content: "Ignored: test already finished." }); continue; }
        steps++;
        const r = await act(call.name, input);
        transcript.push(`${r.ok ? "✓" : "✗"} ${describeCall(call.name, input)} — ${r.note}`);
        log(`      ${r.ok ? "✓" : "✗"} ${describeCall(call.name, input)} — ${r.note.slice(0, 120)}`);
        let text = `${r.ok ? "OK" : "NOT DONE"}: ${r.note}`;
        if (r.errors.length) text += `\nAPPLICATION ERRORS DURING THIS ACTION:\n${r.errors.map((e) => "  - " + e).join("\n")}`;
        if (steps >= maxSteps - 3) text += `\nOnly ${Math.max(0, maxSteps - steps)} action(s) left — clean up and call finish now.`;
        if (r.image) {
          results.push({ type: "tool_result", tool_use_id: call.id, content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: r.image } }, { type: "text", text }] });
        } else {
          const snap = await snapshot(page);
          results.push({ type: "tool_result", tool_use_id: call.id, content: `${text}\n\nCURRENT SCREEN:\n${snap.text}` });
        }
        if (steps >= maxSteps + 2) { verdict = { status: "blocked", summary: `Step limit (${maxSteps}) reached before the test finished.`, expected: "", actual: "", severity: "none", cleanedUp: false }; }
      }
      messages.push({ role: "user", content: results });
    }
  } catch (e) {
    verdict = { status: "blocked", summary: `Test could not run: ${e.message.split("\n")[0]}`, expected: "", actual: "", severity: "none", cleanedUp: false };
  } finally {
    monitor.dialogPolicy = null;
    await page.unroute("**/*", netGuard).catch(() => {});
  }

  // code-level checks the model can't overrule
  if (verdict.status === "pass" && hardErrors.length) {
    verdict = { ...verdict, status: "fail", severity: "major", summary: `Steps looked correct, but the application raised errors: ${hardErrors[0]}`, actual: hardErrors.join("; ") };
  }
  const shot = await shotAt(`${tc.id}_${verdict.status}`);
  return { verdict, transcript, hardErrors, blockedRequests, durationMs: Date.now() - start, screenshot: shot };

  // ---- action implementations ----
  async function act(name, input) {
    const mark = monitor.mark();
    let ok = true, note = "", image = null;
    try {
      if (name === "navigate") {
        if (input.path === "back") await page.goBack({ waitUntil: "domcontentloaded" });
        else if (input.path === "refresh") await page.reload({ waitUntil: "domcontentloaded" });
        else {
          const u = new URL(input.path, baseUrl);
          if (u.origin !== origin) { return { ok: false, note: "Only pages of the application under test can be opened.", errors: [] }; }
          await page.goto(u.toString(), { waitUntil: "domcontentloaded" });
        }
        await settle(page);
        note = `now on ${pathOf(page.url())}`;
      } else if (name === "wait") {
        await sleep(Math.min(Math.max(+input.ms || 0, 0), 5000));
        note = "waited";
      } else if (name === "press_key") {
        await page.keyboard.press(input.key);
        await settle(page);
        note = `pressed ${input.key}`;
      } else if (name === "look") {
        image = (await page.screenshot({ type: "jpeg", quality: 60 })).toString("base64");
        note = "screenshot attached";
      } else {
        const loc = page.locator(`[data-qa-ref="${String(input.ref).replace(/[^\w-]/g, "")}"]`).first();
        if (!(await loc.count())) return { ok: false, note: `Element [${input.ref}] is not on the current screen. Use references from the latest screen description.`, errors: [] };
        if (name === "click") {
          const info = await inspect(loc);
          const g = guard(info, { tag, allowMutation, armed: armed() });
          if (!g.allow) return { ok: false, note: g.reason, errors: [] };
          if (g.arm) armedUntil = Date.now() + ARM_MS;
          await loc.click({ timeout: 6000 });
          await settle(page);
          note = `clicked "${info.label.slice(0, 50) || input.ref}"`;
        } else if (name === "fill") {
          await loc.fill(String(input.text), { timeout: 6000 });
          note = `entered "${String(input.text).slice(0, 60)}"`;
        } else if (name === "select_option") {
          const isSelect = await loc.evaluate((e) => e.tagName === "SELECT");
          if (isSelect) {
            const values = await loc.evaluate((e, want) => [...e.options].filter((o) => o.text.trim().toLowerCase() === want.toLowerCase() || o.text.toLowerCase().includes(want.toLowerCase()) || o.value === want).map((o) => o.value), String(input.option));
            if (!values.length) return { ok: false, note: `No option "${input.option}" in that dropdown.`, errors: [] };
            await loc.selectOption(values[0], { timeout: 6000 });
          } else {
            await loc.click({ timeout: 6000 });
            await page.getByRole("option", { name: String(input.option) }).first().click({ timeout: 6000 });
          }
          await settle(page);
          note = `selected "${input.option}"`;
        } else if (name === "set_checked") {
          await loc.setChecked(!!input.checked, { timeout: 6000 });
          await settle(page);
          note = input.checked ? "ticked" : "unticked";
        }
      }
    } catch (e) {
      ok = false;
      note = `failed: ${e.message.split("\n")[0].slice(0, 200)}`;
    }
    // session lost?
    if (await ctx.onLoginScreen()) {
      await ensureLoggedIn();
      note += " — the session ended (login screen appeared); the tester was logged in again";
    }
    const evts = monitor.since(mark);
    const { fails } = monitor.classify(evts);
    const errors = [];
    for (const f of fails) {
      if (/^JS error|^HTTP 5\d\d/.test(f)) hardErrors.push(f);
      errors.push(f);
    }
    for (const e of evts) {
      if (e.type === "dialog") note += ` — browser dialog: "${e.text.slice(0, 150)}"`;
      if (e.type === "download") note += ` — downloaded file "${e.text}"`;
      if (e.blocked) note += ` — a data-changing request (${e.method} ${pathOf(e.url)}) was blocked by the safety guard`;
    }
    return { ok, note, errors, image };
  }
}

function describeCall(name, i) {
  switch (name) {
    case "click": return `click [${i.ref}]`;
    case "fill": return `type "${String(i.text).slice(0, 40)}" into [${i.ref}]`;
    case "select_option": return `choose "${i.option}" in [${i.ref}]`;
    case "set_checked": return `${i.checked ? "tick" : "untick"} [${i.ref}]`;
    case "press_key": return `press ${i.key}`;
    case "navigate": return `open ${i.path}`;
    case "wait": return `wait ${i.ms}ms`;
    case "look": return "look at screen";
    default: return name;
  }
}

module.exports = { runTestCase, guard, TOOLS, SYSTEM, fillTag, testCaseText };
