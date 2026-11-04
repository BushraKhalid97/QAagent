#!/usr/bin/env node
"use strict";
/**
 * AutoQA AI Tester — give it a URL and a login; it works like a manual tester:
 *
 *   1. EXPLORE     visits every screen and opens every "Add / New / Edit" form
 *   2. UNDERSTAND  Claude works out the business, its modules, records and user journeys
 *   3. PLAN        Claude writes the test cases (lifecycles, workflows, validation, edge cases)
 *   4. EXECUTE     Claude runs each test case in a real browser, step by step, and judges PASS/FAIL
 *   5. CLEAN UP    deletes everything the run created
 *   → QA report (HTML / JSON / JUnit) with steps, expected vs actual, severity and screenshots
 *
 *   ANTHROPIC_API_KEY=… QA_USER=… QA_PASS=… node agent.js --url https://app.example.com --allow-destructive
 */
const fs = require("fs");
const path = require("path");
const { parseArgs, normalizeUrl, pathOf, slug, sleep } = require("./lib/util");
const { Recorder, PageMonitor } = require("./lib/recorder");
const { login, hasPasswordField, looksLikeLoginForm } = require("./lib/auth");
const { writeReports } = require("./lib/report");
const { explore, appMapText } = require("./ai/explore");
const { plan } = require("./ai/planner");
const { runTestCase } = require("./ai/executor");

const HELP = `
AutoQA AI Tester — understands your app and tests it like a manual tester

Usage:
  ANTHROPIC_API_KEY=sk-... QA_USER=me@co.com QA_PASS=secret \\
    node agent.js --url https://app.example.com [--allow-destructive]

Modes:
  (default)              SAFE: read-only journeys only — nothing is saved, nothing is deleted
  --allow-destructive    FULL: also create / edit / delete records (only ones this run creates,
                         tagged with a unique run id; existing data is protected). Use a TEST environment.

Options:
  --max-tests <n>        Max test cases to write and run (default 30)
  --max-steps <n>        Max browser actions per test case (default 40)
  --max-pages <n>        Max screens to explore (default 40)
  --instructions "<txt>" Extra guidance for the planner, e.g. "focus on the order checkout flow"
  --plan <plan.json>     Re-run an existing (reviewed/edited) test plan; skips explore + plan
  --plan-only            Explore and write the test plan, but don't execute it
  --only TC-001,TC-007   Run only these test cases
  --model <id>           Claude model (default claude-opus-5-5)
  --effort <level>       low | medium | high (default medium for execution; planning uses high)
  --login-url <url>      Login page, if not reachable from --url
  --headed               Watch the browser
  --insecure             Accept self-signed HTTPS certificates
  --out <dir>            Report folder (default qa-report)

Exit code: 0 = all executed tests passed, 1 = at least one failed, 2 = could not run.
`;

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (opts.help || !opts.url) { console.log(HELP); process.exit(opts.help ? 0 : 2); }
  if (opts.maxPages === 40 && !process.argv.includes("--max-pages")) opts.maxPages = 30;

  const { chromium } = require("playwright");
  const out = path.resolve(opts.out);
  fs.mkdirSync(path.join(out, "shots"), { recursive: true });
  const origin = new URL(opts.url).origin;
  const baseUrl = opts.url;
  const acct = opts.logins[0] || null;
  const allowMutation = opts.allowDestructive;
  const tag = "QA" + Date.now().toString(36).toUpperCase().slice(-6);
  const started = Date.now();
  const rec = new Recorder();
  rec.account = acct ? acct.user : "";

  let llm;
  if (opts.mock) {
    llm = require(path.resolve(opts.mock)).create({ tag });
  } else {
    const { Claude } = require("./ai/llm");
    llm = new Claude({ model: opts.model, effort: opts.effort });
  }

  console.log(`\nAutoQA AI Tester → ${opts.url}`);
  console.log(`  mode: ${allowMutation ? "FULL (creates/edits/deletes tagged test data)" : "SAFE (read-only)"} · run tag: ${tag} · model: ${opts.mock ? "MOCK" : opts.model}\n`);

  const browser = await chromium.launch({ headless: !opts.headed });
  const context = await browser.newContext({ viewport: { width: 1366, height: 800 }, ignoreHTTPSErrors: opts.ignoreHttpsErrors, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(opts.timeout);
  const monitor = new PageMonitor(page, origin);
  let shotN = 0;
  const shotAt = async (name) => {
    const file = `shots/${String(++shotN).padStart(3, "0")}_${slug(name)}.jpg`;
    try { await page.screenshot({ path: path.join(out, file), fullPage: true, type: "jpeg", quality: 55, timeout: 15000 }); return file; } catch { return ""; }
  };

  // ── login helpers ──
  let loginPath = opts.loginUrl ? new URL(opts.loginUrl, origin).pathname : null;
  const isLoginUrl = (u) => { try { const p = new URL(u).pathname; return (loginPath && p === loginPath) || /\/(login|signin|sign-in|auth\/login)$/i.test(p); } catch { return false; } };
  const onLoginScreen = async () => isLoginUrl(page.url()) || ((await hasPasswordField(page)) && (await looksLikeLoginForm(page)));
  const ctx = { relogging: false };
  const doLogin = async () => {
    ctx.relogging = true;
    try { return await login(page, { baseUrl, loginUrl: opts.loginUrl, user: acct.user, pass: acct.pass, timeout: opts.timeout }); } finally { ctx.relogging = false; }
  };
  const ensureLoggedIn = async () => {
    if (!acct) return;
    if (page.url() === "about:blank") await page.goto(baseUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    if (await onLoginScreen()) { const r = await doLogin(); if (!r.ok) throw new Error("Could not log in again: " + r.message); }
  };

  let appMap = null, testPlan = null, exitCode = 0;
  try {
    // ── login ──
    if (acct) {
      const r = await doLogin();
      rec.add({ suite: "Setup", name: "Log in with the given credentials", status: r.ok ? "pass" : "fail", message: r.message, screenshot: await shotAt("login") });
      if (!r.ok) throw new Error("Login failed — cannot continue. " + r.message);
    }

    if (opts.planFile) {
      testPlan = JSON.parse(fs.readFileSync(opts.planFile, "utf8"));
      console.log(`Using test plan ${opts.planFile} (${testPlan.testCases.length} test cases)\n`);
    } else {
      // ── 1. explore ──
      console.log("1/4 Exploring the application…");
      appMap = await explore(page, { origin, startUrl: page.url().startsWith(origin) ? page.url() : baseUrl, maxPages: opts.maxPages, timeout: opts.timeout, isLoginUrl });
      fs.writeFileSync(path.join(out, "app-map.json"), JSON.stringify(appMap, null, 2));
      rec.add({ suite: "Setup", name: `Explored ${appMap.screens.length} screen(s)`, status: appMap.screens.length ? "pass" : "fail", evidence: appMap.screens.map((s) => `${s.path}${s.opens.length ? ` (opens: ${s.opens.map((o) => o.button).join(", ")})` : ""}`) });
      if (!appMap.screens.length) throw new Error("No screens could be explored.");

      // ── 2+3. understand & plan ──
      console.log(`\n2/4 Understanding the business and writing test cases (${opts.mock ? "mock" : opts.model})…`);
      testPlan = await plan(llm, { appMap, mapText: appMapText(appMap), maxTests: opts.maxTests, account: acct && acct.user, allowMutation, extraInstructions: opts.instructions });
      fs.writeFileSync(path.join(out, "plan.json"), JSON.stringify(testPlan, null, 2));
      console.log(`   App: ${testPlan.app.name} — ${testPlan.app.domain}`);
      console.log(`   ${testPlan.app.summary}`);
      console.log(`   Modules: ${testPlan.modules.map((m) => m.name).join(", ")}`);
      console.log(`   ${testPlan.journeys.length} journeys, ${testPlan.testCases.length} test cases → ${path.join(out, "plan.json")}`);
    }

    // ── 4. execute ──
    let cases = testPlan.testCases;
    if (opts.only.length) cases = cases.filter((t) => opts.only.includes(t.id));
    if (opts.planOnly) {
      cases.forEach((tc) => rec.add({ suite: tc.module, name: `${tc.id} ${tc.title}`, status: "skip", message: "planned (not executed: --plan-only)", evidence: planEvidence(tc, tag) }));
    } else {
      console.log(`\n3/4 Executing ${cases.length} test case(s)…`);
      let anyMutation = false;
      for (const tc of cases) {
        if (tc.mutatesData && !allowMutation) {
          rec.add({ suite: tc.module, name: `${tc.id} ${tc.title}`, status: "skip", message: "Changes data — run with --allow-destructive on a test environment to execute", evidence: planEvidence(tc, tag) });
          continue;
        }
        console.log(`\n  ▶ ${tc.id} [${tc.priority}] ${tc.title}`);
        anyMutation = anyMutation || tc.mutatesData;
        const r = await runTestCase(tc, { llm, page, monitor, origin, baseUrl, tag, allowMutation, maxSteps: opts.maxSteps, shotAt, ensureLoggedIn, onLoginScreen, isRelogging: () => ctx.relogging, log: console.log });
        recordResult(rec, tc, r, tag);
      }

      // ── 5. clean up ──
      if (allowMutation && anyMutation) {
        console.log("\n4/4 Cleaning up test data…");
        const modules = testPlan.modules.filter((m) => cases.some((c) => c.mutatesData && c.module === m.name));
        const cleanup = {
          id: "CLEANUP", module: "Cleanup", journey: "Remove test data", title: `Delete every record containing ${tag}`, type: "delete", priority: "P1", mutatesData: true,
          preconditions: "Test cases have run and may have left records behind.",
          steps: [`Visit each of these screens: ${[...new Set(modules.flatMap((m) => m.screens))].join(", ") || "all data screens"}`, `On each screen, look for any record whose name/text contains {TAG}`, "Delete each such record (confirm any confirmation dialog)", "Verify that no record containing {TAG} remains on any of those screens"],
          expectedResults: ["No record containing {TAG} remains anywhere"], testData: "none",
        };
        const r = await runTestCase(cleanup, { llm, page, monitor, origin, baseUrl, tag, allowMutation, maxSteps: Math.max(opts.maxSteps, 40), shotAt, ensureLoggedIn, onLoginScreen, isRelogging: () => ctx.relogging, log: console.log });
        rec.add({ suite: "Cleanup", name: `Remove all test data tagged ${tag}`, status: r.verdict.status === "pass" ? "pass" : "warn", message: r.verdict.status === "pass" ? r.verdict.summary : `Some test data may remain — search the app for "${tag}". ${r.verdict.summary}`, evidence: r.transcript, screenshot: r.screenshot });
      }
    }
  } catch (e) {
    console.error("\n✗ " + e.message);
    rec.add({ suite: "Setup", name: "AI tester run", status: "fail", message: e.message.split("\n")[0] });
    exitCode = 2;
  } finally {
    await browser.close().catch(() => {});
  }

  const summary = rec.summary();
  const usage = llm.usage || {};
  const cost = llm.costUsd ? llm.costUsd() : null;
  const data = {
    meta: { url: opts.url, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, safeMode: !allowMutation, tool: "AutoQA AI Tester 1.0" },
    accounts: acct ? [acct.user] : [],
    summary,
    screens: (appMap ? appMap.screens : []).map((s) => ({ account: rec.account, path: s.path, url: s.url, title: s.title, shot: "" })),
    tests: rec.tests,
    ai: testPlan ? { app: testPlan.app, modules: testPlan.modules, journeys: testPlan.journeys, testCaseCount: testPlan.testCases.length, tag, model: opts.mock ? "mock" : opts.model, usage, costUsd: cost } : null,
  };
  writeReports(out, data);

  const line = "═".repeat(64);
  console.log(`\n${line}\n  RESULT: ${summary.result}\n  ${summary.total} checks · ${summary.pass} passed · ${summary.fail} failed · ${summary.warn} warnings · ${summary.skip} blocked/skipped`);
  if (usage.requests) console.log(`  Claude: ${usage.requests} requests · ${usage.input + usage.cacheRead + usage.cacheWrite} input / ${usage.output} output tokens${cost != null ? ` · ≈ $${cost.toFixed(2)}` : ""}`);
  console.log(line);
  const defects = rec.tests.filter((t) => t.status === "fail");
  if (defects.length) {
    console.log("\nDefects found:");
    defects.forEach((t) => console.log(`  ✗ ${t.name} — ${t.message}`));
  }
  console.log(`\nReport: ${path.join(out, "report.html")}\n`);
  process.exit(exitCode || (summary.fail ? 1 : 0));
}

function planEvidence(tc, tag) {
  const f = (s) => String(s).split("{TAG}").join(tag);
  return [`Journey: ${tc.journey} · ${tc.type} · ${tc.priority}`, `Preconditions: ${f(tc.preconditions)}`, ...tc.steps.map((s, i) => `Step ${i + 1}: ${f(s)}`), ...tc.expectedResults.map((s) => `Expected: ${f(s)}`)];
}

function recordResult(rec, tc, r, tag) {
  const v = r.verdict;
  const status = v.status === "pass" ? "pass" : v.status === "fail" ? "fail" : "skip";
  const f = (s) => String(s).split("{TAG}").join(tag);
  const evidence = [
    `Journey: ${tc.journey} · ${tc.type} · ${tc.priority}${v.status === "fail" ? ` · Severity: ${v.severity.toUpperCase()}` : ""}`,
    ...(v.status !== "pass" && v.expected ? [`Expected: ${v.expected}`, `Actual: ${v.actual}`] : []),
    ...tc.expectedResults.map((s) => `Expected result: ${f(s)}`),
    "— Steps executed —",
    ...r.transcript,
  ];
  if (r.hardErrors.length) evidence.push("— Application errors —", ...r.hardErrors);
  if (tc.mutatesData && v.cleanedUp === false) evidence.push(`⚠ Test data may remain (search for "${tag}")`);
  rec.add({
    suite: tc.module,
    name: `${tc.id} ${f(tc.title)}`,
    status,
    message: (v.status === "blocked" ? "BLOCKED: " : v.status === "fail" ? `[${v.severity}] ` : "") + v.summary,
    evidence,
    screenshot: r.screenshot,
    durationMs: r.durationMs,
  });
}

main().catch((e) => { console.error("AutoQA AI Tester crashed:", e); process.exit(2); });
