"use strict";
/**
 * Recorder: collects every test case result.
 * status: "pass" | "fail" | "warn" | "skip"
 *   fail = a defect that breaks the app or a security problem (counts against PASS)
 *   warn = quality issue worth fixing (a11y, slow page, mobile overflow) — does not fail the run
 */
class Recorder {
  constructor(log = console.log) {
    this.tests = [];
    this.account = "";
    this.log = log;
    this.counter = 0;
  }

  add({ suite, name, screen = "", status, message = "", evidence = [], screenshot = "", durationMs = 0 }) {
    const t = {
      id: `TC-${String(++this.counter).padStart(4, "0")}`,
      account: this.account, suite, screen, name, status, message,
      evidence: evidence.slice(0, 25), screenshot, durationMs,
    };
    this.tests.push(t);
    const icon = { pass: "PASS", fail: "FAIL", warn: "WARN", skip: "SKIP" }[status] || status;
    this.log(`  [${icon}] ${suite} › ${screen ? screen + " › " : ""}${name}${message && status !== "pass" ? " — " + message : ""}`);
    return t;
  }

  /** Run fn and record its outcome. fn returns {status, message, evidence, screenshot} or throws. */
  async run(suite, name, screen, fn) {
    const start = Date.now();
    try {
      const r = (await fn()) || {};
      return this.add({ suite, name, screen, status: r.status || "pass", message: r.message || "", evidence: r.evidence || [], screenshot: r.screenshot || "", durationMs: Date.now() - start });
    } catch (e) {
      return this.add({ suite, name, screen, status: "fail", message: (e && e.message ? e.message : String(e)).split("\n")[0].slice(0, 400), durationMs: Date.now() - start });
    }
  }

  summary() {
    const s = { total: this.tests.length, pass: 0, fail: 0, warn: 0, skip: 0 };
    for (const t of this.tests) s[t.status] = (s[t.status] || 0) + 1;
    s.result = s.fail > 0 ? "FAIL" : "PASS";
    return s;
  }
}

/**
 * PageMonitor: listens to a page for JS errors, console errors, failed network
 * calls, dialogs and downloads, so each check can ask "what went wrong since X?".
 */
class PageMonitor {
  constructor(page, origin) {
    this.events = [];
    this.origin = origin;
    this.blocked = 0;
    this.blockedUrls = new Set();
    page.on("pageerror", (err) => this.push({ type: "pageerror", text: (err && err.message) || String(err) }));
    page.on("console", (msg) => {
      if (msg.type() === "error") this.push({ type: "console", text: msg.text(), url: (msg.location() || {}).url || "" });
    });
    page.on("response", (resp) => {
      const st = resp.status();
      if (st >= 400) {
        const req = resp.request();
        this.push({ type: "http", status: st, url: resp.url(), method: req.method(), resource: req.resourceType() });
      }
    });
    page.on("requestfailed", (req) => {
      const f = (req.failure() || {}).errorText || "failed";
      if (/ERR_ABORTED|cancelled|BLOCKED_BY_CLIENT/i.test(f) && !this._isBlocked(req)) return; // navigations cancel in-flight requests; not a defect
      this.push({ type: "reqfail", text: f, url: req.url(), method: req.method(), resource: req.resourceType(), blocked: this._isBlocked(req) });
    });
    page.on("dialog", (d) => {
      this.push({ type: "dialog", text: `${d.type()}: ${d.message()}` });
      d.dismiss().catch(() => {}); // never confirm native "Are you sure?" dialogs
    });
    page.on("download", (d) => this.push({ type: "download", text: d.suggestedFilename(), url: d.url() }));
  }
  _isBlocked(req) { return this.blockedUrls.has(req.method() + " " + req.url()); }
  push(e) { e.t = Date.now(); this.events.push(e); }
  mark() { return this.events.length; }
  since(i) { return this.events.slice(i); }

  sameOrigin(url) { try { return new URL(url).origin === this.origin; } catch { return false; } }

  /** Classify events into failures and warnings. */
  classify(evts, { ignoreBlocked = false } = {}) {
    const fails = [], warns = [];
    const anyBlocked = evts.some((e) => e.blocked);
    for (const e of evts) {
      if (e.type === "pageerror") {
        if ((ignoreBlocked || anyBlocked) && /fetch|network|load failed|abort/i.test(e.text)) continue;
        fails.push(`JS error: ${e.text}`);
      } else if (e.type === "console") {
        if ((ignoreBlocked || anyBlocked) && /fetch|network|ERR_FAILED|blocked|abort/i.test(e.text)) continue;
        if (/^Failed to load resource/i.test(e.text)) continue; // duplicated by the http event
        if (/^Warning:|webpack|hmr|Download the React DevTools/i.test(e.text)) warns.push(`Console: ${e.text.slice(0, 200)}`);
        else fails.push(`Console error: ${e.text.slice(0, 300)}`);
      } else if (e.type === "http") {
        const line = `HTTP ${e.status} ${e.method} ${e.url}`;
        if (/favicon/i.test(e.url)) warns.push(line);
        else if (this.sameOrigin(e.url)) fails.push(line);
        else warns.push(`(third-party) ${line}`);
      } else if (e.type === "reqfail") {
        if (e.blocked) continue;
        const line = `Request failed (${e.text}) ${e.method} ${e.url}`;
        if (this.sameOrigin(e.url)) fails.push(line); else warns.push(`(third-party) ${line}`);
      }
    }
    return { fails: [...new Set(fails)], warns: [...new Set(warns)] };
  }
}

module.exports = { Recorder, PageMonitor };
