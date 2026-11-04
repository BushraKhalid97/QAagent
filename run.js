#!/usr/bin/env node
"use strict";
/**
 * AutoQA — give it a URL (+ login) and it tests the whole web app:
 *   smoke · authentication · every screen it can discover · every safe button,
 *   tab, dropdown, search box and form · responsive layouts · accessibility ·
 *   access control · your own business use cases — then prints PASS / FAIL and
 *   writes an HTML report.
 *
 *   node run.js --url https://app.example.com --user me@example.com --pass secret
 */
require("./lib/env"); // reads your private .env (API key etc.)
const fs = require("fs");
const path = require("path");
const { parseArgs, normalizeUrl, pathOf, slug, SKIP_URL, DOWNLOAD_EXT, sleep } = require("./lib/util");
const { Recorder, PageMonitor } = require("./lib/recorder");
const { login, logout, hasPasswordField, looksLikeLoginForm, gotoLoginForm, visibleErrorText } = require("./lib/auth");

const STATIC_ASSET = /(\/_next\/static\/|hot-update|__webpack|\/sockjs|\/static\/|\.(js|css|map|png|jpe?g|svg|gif|woff2?|ico)(\?|$))/i;
const { runScreenChecks } = require("./lib/checks");
const { exploreScreen } = require("./lib/interactions");
const { loadScenarios, runScenario } = require("./lib/scenarios");
const { writeReports } = require("./lib/report");

const HELP = `
AutoQA — automated end-to-end QA for any web app

Usage:
  node run.js --url <URL> [--user <name> --pass <password>] [options]

  Credentials can also come from env vars QA_URL, QA_USER, QA_PASS (keeps them out of shell history).

Options:
  --login user:pass       Test with an extra account (repeatable; great for role-based apps)
  --login-url <url>       Login page, if it is not reachable from the start URL
  --scenarios <file>      JSON file of custom use-case test cases (repeatable)
  --max-pages <n>         Max screens to discover per account (default 40)
  --max-depth <n>         Max link depth from the start page (default 5)
  --max-clicks <n>        Max controls clicked per screen (default 25)
  --slow-ms <ms>          Page-load warning threshold (default 5000)
  --timeout <ms>          Navigation timeout (default 30000)
  --exclude <regex>       Skip URLs matching regex (repeatable)
  --public <regex>        URLs that are public on purpose (excluded from access-control test)
  --allow-destructive     Also click Delete/Save/Submit/... and allow POST/PUT/DELETE (use on test env only!)
  --no-interactions       Only load & check screens, don't click anything
  --no-responsive         Skip mobile/tablet layout checks
  --check-external        Also verify external links respond
  --insecure              Ignore HTTPS certificate errors (self-signed test servers)
  --headed                Show the browser while testing
  --out <dir>             Report folder (default ./qa-report)

Exit code: 0 = PASS, 1 = FAIL (at least one failed test), 2 = could not run.
`;

function loadPlaywright() {
  try { return require("playwright"); } catch {
    try { return require(path.join(__dirname, "node_modules", "playwright")); } catch {
      console.error("Playwright is not installed. Run:  cd qa && npm install && npx playwright install chromium");
      process.exit(2);
    }
  }
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (opts.help || !opts.url) { console.log(HELP); process.exit(opts.help ? 0 : 2); }

  const { chromium } = loadPlaywright();
  const out = path.resolve(opts.out);
  fs.mkdirSync(path.join(out, "shots"), { recursive: true });
  const base = new URL(opts.url);
  const origin = base.origin;
  const started = Date.now();
  const rec = new Recorder();
  const screens = [];
  const scenarios = loadScenarios(opts.scenarios);
  const accounts = opts.logins.length ? opts.logins : [null];
  const loginPath = opts.loginUrl ? new URL(opts.loginUrl, origin).pathname : null;

  console.log(`\nAutoQA → ${opts.url}  (${accounts.length} account(s), ${scenarios.length} custom scenario(s), ${opts.allowDestructive ? "DESTRUCTIVE" : "safe"} mode)\n`);
  const browser = await chromium.launch({ headless: !opts.headed });
  const newCtx = () => browser.newContext({ viewport: { width: 1366, height: 800 }, ignoreHTTPSErrors: opts.ignoreHttpsErrors, acceptDownloads: true });

  // ───────────────────────── Smoke / security (once) ─────────────────────────
  {
    const ctx = await newCtx();
    await rec.run("Smoke", "Site is reachable", "", async () => {
      const t0 = Date.now();
      const r = await ctx.request.get(opts.url, { timeout: opts.timeout });
      const ms = Date.now() - t0;
      if (r.status() >= 500) return { status: "fail", message: `HTTP ${r.status()}` };
      return { status: ms > opts.slowMs ? "warn" : "pass", message: `HTTP ${r.status()} in ${ms} ms` };
    });
    await rec.run("Security", "Uses HTTPS", "", async () => {
      if (base.protocol === "https:") return { message: "HTTPS" };
      if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(base.hostname)) return { status: "skip", message: "local test server" };
      return { status: "fail", message: "Site is served over plain HTTP — credentials travel unencrypted" };
    });
    await rec.run("Security", "Security headers present", "", async () => {
      const r = await ctx.request.get(opts.url, { timeout: opts.timeout, maxRedirects: 5 });
      const h = r.headers();
      const missing = [];
      if (!h["x-frame-options"] && !/frame-ancestors/i.test(h["content-security-policy"] || "")) missing.push("X-Frame-Options / CSP frame-ancestors (clickjacking)");
      if (!h["x-content-type-options"]) missing.push("X-Content-Type-Options: nosniff");
      if (base.protocol === "https:" && !h["strict-transport-security"]) missing.push("Strict-Transport-Security (HSTS)");
      if (!h["content-security-policy"]) missing.push("Content-Security-Policy");
      if (h["x-powered-by"]) missing.push(`X-Powered-By reveals "${h["x-powered-by"]}"`);
      return { status: missing.length ? "warn" : "pass", message: missing.length ? `${missing.length} missing/weak` : "", evidence: missing };
    });
    await ctx.close();
  }

  for (const acct of accounts) {
    rec.account = acct ? acct.user : "";
    console.log(`\n── Account: ${acct ? acct.user : "(no login)"} ──`);
    const ctx = await newCtx();
    const page = await ctx.newPage();
    page.setDefaultTimeout(opts.timeout);
    const monitor = new PageMonitor(page, origin);
    const apiCalls = new Set();
    page.on("request", (r) => {
      if (["fetch", "xhr"].includes(r.resourceType()) && r.method() === "GET" && monitor.sameOrigin(r.url()) && !STATIC_ASSET.test(r.url()) && apiCalls.size < 30) apiCalls.add(r.url());
    });
    const tag = acct ? slug(acct.user) + "_" : "";
    let shotN = 0;
    const shotAt = async (name, p = page) => {
      const file = `shots/${tag}${String(++shotN).padStart(3, "0")}_${slug(name)}.jpg`;
      try { await p.screenshot({ path: path.join(out, file), fullPage: true, type: "jpeg", quality: 55, timeout: 15000 }); return file; } catch { return ""; }
    };

    // ───────────────────────── Authentication ─────────────────────────
    let loggedIn = false;
    let detectedLoginPath = loginPath;
    if (acct) {
      const nctx = await newCtx();
      const np = await nctx.newPage();
      await rec.run("Authentication", "Login form is present", "", async () => {
        const f = await gotoLoginForm(np, opts.url, opts.loginUrl, opts.timeout);
        if (!f.pass && !f.user) return { status: "fail", message: "No login form found", screenshot: await shotAt("no_login_form", np) };
        detectedLoginPath = detectedLoginPath || new URL(np.url()).pathname;
        return { message: `found at ${pathOf(np.url())}`, screenshot: await shotAt("login_form", np) };
      });
      await rec.run("Authentication", "Empty login is rejected", "", async () => {
        const f = await gotoLoginForm(np, opts.url, opts.loginUrl, opts.timeout);
        if (!f.submit) return { status: "skip", message: "no submit button found" };
        await np.click("[data-autoqa=submit]");
        await sleep(1500);
        if (await hasPasswordField(np)) return { message: "stays on login form" };
        return { status: "fail", message: "Empty credentials were accepted!", screenshot: await shotAt("empty_login_accepted", np) };
      });
      await rec.run("Authentication", "Wrong password is rejected with a message", "", async () => {
        const r = await login(np, { baseUrl: opts.url, loginUrl: opts.loginUrl, user: acct.user, pass: acct.pass + "#Wrong!9", timeout: 8000 });
        if (r.ok) return { status: "fail", message: "Wrong password was accepted!", screenshot: await shotAt("wrong_pw_accepted", np) };
        const err = await visibleErrorText(np);
        const shot = await shotAt("wrong_pw", np);
        return err ? { message: `shows: "${err.slice(0, 100)}"`, screenshot: shot } : { status: "warn", message: "rejected, but no error message is shown to the user", screenshot: shot };
      });
      await nctx.close();

      await rec.run("Authentication", "Valid credentials log in", "", async () => {
        const r = await login(page, { baseUrl: opts.url, loginUrl: opts.loginUrl, user: acct.user, pass: acct.pass, timeout: opts.timeout });
        loggedIn = r.ok;
        return { status: r.ok ? "pass" : "fail", message: r.message, screenshot: await shotAt("after_login") };
      });
      if (loggedIn) {
        await rec.run("Security", "Session cookie flags (HttpOnly / Secure / SameSite)", "", async () => {
          const cookies = (await ctx.cookies(origin)).filter((c) => /sess|auth|token|sid|jwt|login/i.test(c.name));
          if (!cookies.length) return { status: "skip", message: "no session-like cookie (token may be in storage)" };
          const issues = [];
          for (const c of cookies) {
            if (!c.httpOnly) issues.push(`${c.name}: not HttpOnly (readable by scripts)`);
            if (base.protocol === "https:" && !c.secure) issues.push(`${c.name}: not Secure`);
            if (c.sameSite === "None") issues.push(`${c.name}: SameSite=None`);
          }
          return { status: issues.length ? "warn" : "pass", message: cookies.map((c) => c.name).join(", "), evidence: issues };
        });
      } else {
        console.log("  Login failed — testing only what is reachable without login.");
      }
    }

    const isLoginUrl = (u) => {
      const p = new URL(u).pathname;
      return (detectedLoginPath && p === detectedLoginPath) || /\/(login|signin|sign-in|auth\/login)$/i.test(p);
    };
    /** True when `p` is showing the login screen rather than the screen we asked for. */
    const onLoginScreen = async (p, requested) => {
      if (isLoginUrl(p.url())) return true;
      if (!(await hasPasswordField(p))) return false;
      if (requested && normalizeUrl(p.url()) !== normalizeUrl(requested)) return true;
      return looksLikeLoginForm(p);
    };
    const isLoggedOut = async () => !!acct && loggedIn && (await onLoginScreen(page, null));

    // ───────────────────────── Discover & test every screen ─────────────────────────
    const queue = [];
    const queued = new Set();
    const visited = new Set();
    const perPath = new Map();
    const downloads = new Set();
    const external = new Set();
    const enqueue = (u, depth) => {
      const n = normalizeUrl(u, origin);
      if (!n) return;
      if (!n.startsWith(origin)) { external.add(n); return; }
      if (DOWNLOAD_EXT.test(new URL(n).pathname)) { downloads.add(n); return; }
      if (SKIP_URL.test(n) || opts.exclude.some((r) => r.test(n)) || queued.has(n)) return;
      if (acct && loggedIn && isLoginUrl(n)) return;
      const p = new URL(n).pathname;
      const c = perPath.get(p) || 0;
      if (c >= 3) return; // don't explode on ?page=1,2,3...
      perPath.set(p, c + 1);
      queued.add(n);
      queue.push({ url: n, depth });
    };
    enqueue(page.url() !== "about:blank" ? page.url() : opts.url, 0);
    enqueue(opts.url, 0);

    while (queue.length && visited.size < opts.maxPages) {
      const { url, depth } = queue.shift();
      if (visited.has(url)) continue;
      const mark = monitor.mark();
      const t0 = Date.now();
      let resp;
      try {
        resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: opts.timeout });
        await page.waitForLoadState("load", { timeout: opts.timeout }).catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      } catch (e) {
        visited.add(url);
        rec.add({ suite: "Screen", screen: pathOf(url), name: "Page loads (HTTP status)", status: "fail", message: e.message.split("\n")[0] });
        continue;
      }
      const loadMs = Date.now() - t0;
      if (acct && loggedIn && !isLoginUrl(url) && (await onLoginScreen(page, url))) {
        rec.add({ suite: "Authentication", screen: pathOf(url), name: "Session stays active while navigating", status: "fail", message: "Got sent back to the login screen — re-logging in" });
        const r = await login(page, { baseUrl: opts.url, loginUrl: opts.loginUrl, user: acct.user, pass: acct.pass, timeout: opts.timeout });
        if (!r.ok) break;
        queue.unshift({ url, depth });
        continue;
      }
      const finalUrl = normalizeUrl(page.url(), origin) || url;
      visited.add(url);
      if (finalUrl !== url && visited.has(finalUrl)) continue; // redirect to a screen we already tested
      visited.add(finalUrl);
      queued.add(finalUrl);
      const screen = pathOf(finalUrl);
      console.log(`\n▶ Screen ${visited.size}: ${screen}`);
      const shot = await shotAt(screen);
      const dom = await runScreenChecks(page, { rec, screen, monitor, mark, loadMs, status: resp ? resp.status() : 0, opts, shot, shotAt });
      screens.push({ account: rec.account, path: screen, url: finalUrl, title: dom.title, shot });

      // links → more screens
      if (depth < opts.maxDepth) {
        const links = await page.evaluate(() => [...document.querySelectorAll("a[href], area[href]")].map((a) => a.href)).catch(() => []);
        links.forEach((l) => enqueue(l, depth + 1));
      }
      if (opts.interactions) {
        const found = await exploreScreen(page, { rec, screen, monitor, opts, url: finalUrl, origin, isLoggedOut, shotAt });
        found.forEach((u) => enqueue(u, depth + 1));
        if (await isLoggedOut()) {
          await login(page, { baseUrl: opts.url, loginUrl: opts.loginUrl, user: acct.user, pass: acct.pass, timeout: opts.timeout });
        }
      }
    }
    if (queue.length) rec.add({ suite: "Coverage", name: `Screen limit reached: ${queue.length} more screen(s) not tested`, status: "skip", message: "raise --max-pages to test them", evidence: queue.map((q) => pathOf(q.url)) });
    rec.add({ suite: "Coverage", name: `Discovered ${screens.filter((s) => s.account === rec.account).length} screen(s)`, status: screens.length ? "pass" : "fail", evidence: screens.filter((s) => s.account === rec.account).map((s) => s.path) });

    // file / download links
    for (const d of [...downloads].slice(0, 20)) {
      await rec.run("Links", `Download link works: ${pathOf(d)}`, "", async () => {
        const r = await ctx.request.get(d, { timeout: opts.timeout });
        return { status: r.status() >= 400 ? "fail" : "pass", message: `HTTP ${r.status()}, ${(await r.body()).length} bytes` };
      });
    }
    if (opts.checkExternal) {
      for (const e of [...external].slice(0, 40)) {
        await rec.run("Links", `External link responds: ${e}`, "", async () => {
          const r = await ctx.request.get(e, { timeout: 15000 }).catch((err) => ({ status: () => 0, err }));
          const st = r.status();
          return { status: st === 0 || st >= 400 ? (st === 403 || st === 429 || st === 999 ? "warn" : "fail") : "pass", message: `HTTP ${st || "unreachable"}` };
        });
      }
    }

    // ───────────────────────── Custom use cases ─────────────────────────
    for (const sc of scenarios) {
      if (sc.accounts && acct && !sc.accounts.includes(acct.user)) continue;
      if (sc.accounts && !acct) continue;
      await rec.run("Use cases", sc.name, "", async () => {
        const mark = monitor.mark();
        const r = await runScenario(page, sc, { baseUrl: opts.url, timeout: opts.timeout, shotAt });
        if (r.status === "pass") {
          const allowed = (sc.allowHttp || []).map(String);
          const fails = monitor.classify(monitor.since(mark)).fails.filter((f) => !allowed.some((c) => f.startsWith(`HTTP ${c} `)));
          if (fails.length) return { status: "fail", message: `steps passed but errors occurred: ${fails[0]}`, evidence: [...r.evidence, ...fails] };
        }
        return r;
      });
    }

    // ───────────────────────── Access control ─────────────────────────
    if (acct && loggedIn) {
      const actx = await newCtx();
      const ap = await actx.newPage();
      const mine = screens.filter((s) => s.account === rec.account && !isLoginUrl(s.url) && !opts.publicPaths.some((r) => r.test(s.url)));
      for (const s of mine.slice(0, 15)) {
        await rec.run("Access control", "Screen is blocked without login", s.path, async () => {
          const r = await ap.goto(s.url, { waitUntil: "domcontentloaded", timeout: opts.timeout });
          await ap.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
          const st = r ? r.status() : 0;
          if (st === 401 || st === 403) return { message: `HTTP ${st}` };
          if (await onLoginScreen(ap, s.url)) return { message: `redirected to login (${pathOf(ap.url())})` };
          return { status: "fail", message: "Screen is visible WITHOUT logging in (use --public if this is intended)", screenshot: await shotAt("unauth_" + s.path, ap) };
        });
      }
      for (const api of [...apiCalls].slice(0, 15)) {
        await rec.run("Access control", `API is blocked without login: ${pathOf(api)}`, "", async () => {
          const r = await actx.request.get(api, { maxRedirects: 0, timeout: opts.timeout });
          const st = r.status();
          if ([401, 403].includes(st) || (st >= 300 && st < 400)) return { message: `HTTP ${st}` };
          if (st === 200) {
            const ct = r.headers()["content-type"] || "";
            if (/html/.test(ct)) return { status: "warn", message: "HTTP 200 HTML (probably a login page) — expected 401" };
            const anon = (await r.text()).trim();
            const authed = await ctx.request.get(api, { timeout: opts.timeout }).then((x) => x.text()).catch(() => "");
            if (anon !== authed.trim() && anon.length < Math.max(200, authed.length / 4))
              return { message: `HTTP 200 but returns no private data when logged out (${anon.slice(0, 60)})` };
            return { status: "fail", message: `HTTP 200 — same data returned without authentication (${ct})`, evidence: [anon.slice(0, 300)] };
          }
          return { message: `HTTP ${st}` };
        });
      }
      await actx.close();

      // logout last
      await rec.run("Authentication", "Logout ends the session", "", async () => {
        const target = (mine[0] || {}).url || opts.url;
        await page.goto(target, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
        if (!(await logout(page))) return { status: "skip", message: "No logout control found" };
        await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
        await page.goto(target, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
        if (await onLoginScreen(page, target)) return { message: "protected screen asks for login again" };
        return { status: "fail", message: "Still able to view protected screen after logout", screenshot: await shotAt("after_logout") };
      });
    }
    await ctx.close();
  }

  await browser.close();
  const summary = rec.summary();
  const data = {
    meta: { url: opts.url, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, safeMode: !opts.allowDestructive, tool: "AutoQA 1.0" },
    accounts: accounts.filter(Boolean).map((a) => a.user),
    summary, screens, tests: rec.tests,
  };
  writeReports(out, data);

  const line = "═".repeat(60);
  console.log(`\n${line}\n  RESULT: ${summary.result}\n  ${summary.total} tests · ${summary.pass} passed · ${summary.fail} failed · ${summary.warn} warnings · ${summary.skip} skipped\n  ${screens.length} screen(s) tested in ${((Date.now() - started) / 1000).toFixed(0)} s\n${line}`);
  const failed = rec.tests.filter((t) => t.status === "fail");
  if (failed.length) {
    console.log("\nFailed test cases:");
    for (const t of failed.slice(0, 50)) console.log(`  ✗ ${t.id} ${t.account ? "[" + t.account + "] " : ""}${t.suite} › ${t.screen ? t.screen + " › " : ""}${t.name} — ${t.message}`);
  }
  console.log(`\nReport: ${path.join(out, "report.html")}\n        ${path.join(out, "junit.xml")} (CI)  ·  ${path.join(out, "report.json")}\n`);
  process.exit(summary.fail ? 1 : 0);
}

main().catch((e) => { console.error("AutoQA crashed:", e); process.exit(2); });
