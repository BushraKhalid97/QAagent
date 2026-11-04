"use strict";
/**
 * Functional exploration of a screen: clicks every safe button / tab / menu,
 * exercises every dropdown, probes form validation and search boxes, and
 * reports anything that throws, errors or breaks. New screens reached by a
 * click are handed back to the crawler.
 *
 * SAFE MODE (default): buttons that look destructive are not clicked, native
 * confirm() dialogs are dismissed, and any POST/PUT/PATCH/DELETE request fired
 * during exploration is blocked, so the QA run can't change your data.
 */
const { DESTRUCTIVE, sleep, normalizeUrl, pathOf } = require("./util");

async function listClickables(page, allowDestructive) {
  return page.evaluate(({ allowDestructive, destructiveSrc }) => {
    const DESTRUCTIVE = new RegExp(destructiveSrc, "i");
    const vis = (el) => {
      const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && s.pointerEvents !== "none";
    };
    document.querySelectorAll("[data-autoqa-c]").forEach((e) => e.removeAttribute("data-autoqa-c"));
    const els = [...document.querySelectorAll('button, [role=button], [role=tab], [role=menuitem], [role=switch], [role=checkbox], summary, input[type=button], input[type=checkbox], input[type=radio], a:not([href]), [onclick], th[aria-sort], th.sortable')];
    const seen = new Map();
    const out = [];
    for (const el of els) {
      if (!vis(el) || el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      if (el.closest("[data-autoqa-skip]")) continue;
      const label = (el.getAttribute("aria-label") || el.innerText || el.value || el.title || "").replace(/\s+/g, " ").trim().slice(0, 60);
      // icon-only buttons (e.g. "⎋") are judged by their tooltip / aria text too
      const meaning = `${label} ${el.title || ""} ${el.getAttribute("aria-label") || ""}`;
      const inForm = !!el.closest("form");
      // a <button> without a type attribute reports type "submit" even outside a form — only real form submits count
      const isSubmit = inForm && (el.type === "submit");
      let skip = "";
      if (!allowDestructive && DESTRUCTIVE.test(meaning)) skip = "looks destructive";
      else if (!allowDestructive && isSubmit) skip = "form submit button";
      const sig = `${el.tagName.toLowerCase()}|${el.getAttribute("role") || el.type || ""}|${label}`;
      const n = seen.get(sig) || 0; seen.set(sig, n + 1);
      const key = `${sig}#${n}`;
      el.setAttribute("data-autoqa-c", key);
      out.push({ key, label: label || `<${el.tagName.toLowerCase()}>`, kind: el.getAttribute("role") || el.type || el.tagName.toLowerCase(), skip });
    }
    return out;
  }, { allowDestructive, destructiveSrc: DESTRUCTIVE.source });
}

async function dialogOpen(page) {
  return page.evaluate(() => [...document.querySelectorAll('[role=dialog], [role=alertdialog], dialog[open], .modal.show, .modal-open .modal')].some((e) => {
    const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0;
  })).catch(() => false);
}

/** Make sure the page is on `url` and settled. */
async function ensureAt(page, url, timeout) {
  if (normalizeUrl(page.url()) !== normalizeUrl(url)) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  }
  await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
}

async function settle(page) {
  await sleep(250);
  await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
  await sleep(150);
}

/**
 * @returns {Promise<string[]>} newly discovered URLs
 */
async function exploreScreen(page, ctx) {
  const { rec, screen, monitor, opts, url, origin, isLoggedOut } = ctx;
  const found = new Set();
  const S = "Interactions";

  // Block data-changing requests while exploring (safe mode).
  const blocker = async (route) => {
    const req = route.request();
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method()) && monitor.sameOrigin(req.url())) {
      monitor.blockedUrls.add(req.method() + " " + req.url());
      return route.abort("blockedbyclient");
    }
    return route.fallback();
  };
  if (!opts.allowDestructive) await page.route("**/*", blocker);

  try {
    await ensureAt(page, url, opts.timeout);
    let items = await listClickables(page, opts.allowDestructive);
    const skipped = items.filter((i) => i.skip);
    if (skipped.length) rec.add({ suite: S, screen, name: `Skipped ${skipped.length} unsafe control(s) (safe mode)`, status: "skip", evidence: skipped.map((i) => `"${i.label}" — ${i.skip}`) });
    const todo = items.filter((i) => !i.skip).slice(0, opts.maxClicks);
    if (items.filter((i) => !i.skip).length > opts.maxClicks) rec.add({ suite: S, screen, name: `Only first ${opts.maxClicks} controls clicked (raise --max-clicks for more)`, status: "skip" });

    for (const item of todo) {
      await rec.run(S, `Click "${item.label}" (${item.kind})`, screen, async () => {
        await ensureAt(page, url, opts.timeout);
        let loc = page.locator(`[data-autoqa-c="${item.key.replace(/"/g, '\\"')}"]`);
        if (!(await loc.count())) {
          await listClickables(page, opts.allowDestructive);
          loc = page.locator(`[data-autoqa-c="${item.key.replace(/"/g, '\\"')}"]`);
          if (!(await loc.count())) return { status: "skip", message: "control no longer present (screen changed)" };
        }
        const before = page.url();
        const mark = monitor.mark();
        try {
          await loc.first().click({ timeout: 5000 });
        } catch (e) {
          if (/intercepts pointer events|not visible|outside of the viewport|detached/i.test(e.message)) return { status: "warn", message: "Control could not be clicked (covered/hidden by another element)" };
          throw e;
        }
        await settle(page);
        const after = page.url();
        const notes = [];
        if (normalizeUrl(after) !== normalizeUrl(before)) {
          if (await isLoggedOut()) return { status: "fail", message: `Clicking it logged the user out (went to ${pathOf(after)})` };
          const n = normalizeUrl(after);
          if (n && monitor.sameOrigin(n)) found.add(n);
          notes.push(`navigates to ${pathOf(after)}`);
        }
        if (await dialogOpen(page)) {
          notes.push("opens a dialog");
          await page.keyboard.press("Escape").catch(() => {});
          await sleep(200);
        }
        const evts = monitor.since(mark);
        const blocked = evts.filter((e) => e.blocked).length;
        if (blocked) notes.push(`${blocked} data-changing request(s) blocked by safe mode`);
        evts.filter((e) => e.type === "download").forEach((d) => notes.push(`downloads "${d.text}"`));
        evts.filter((e) => e.type === "dialog").forEach((d) => notes.push(`native ${d.text} (dismissed)`));
        const { fails, warns } = monitor.classify(evts, { ignoreBlocked: blocked > 0 });
        // a crashed client app often renders an error overlay
        const crashed = await page.locator("text=/Application error|Unhandled Runtime Error|Something went wrong/i").first().isVisible().catch(() => false);
        if (crashed) fails.push("Screen shows an application error after the click");
        if (fails.length) {
          return { status: "fail", message: fails[0], evidence: [...fails, ...warns, ...notes], screenshot: await ctx.shotAt(`click_${item.label}`) };
        }
        return { status: warns.length ? "warn" : "pass", message: notes.join("; ") || "responds without errors", evidence: [...warns] };
      });
    }

    // Dropdowns / filters
    await ensureAt(page, url, opts.timeout);
    const selInfo = await page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
      return [...document.querySelectorAll("select")].filter((e) => vis(e) && !e.disabled).map((e, i) => {
        e.setAttribute("data-autoqa-s", String(i));
        let label = e.getAttribute("aria-label") || "";
        if (!label && e.id) label = (document.querySelector(`label[for="${CSS.escape(e.id)}"]`) || {}).innerText || "";
        if (!label && e.closest("label")) { const c = e.closest("label").cloneNode(true); c.querySelectorAll("select").forEach((x) => x.remove()); label = c.innerText; }
        if (!label) { const prev = e.previousElementSibling; if (prev && /LABEL|SPAN|DIV/.test(prev.tagName)) label = prev.innerText; }
        return { i, label: (label || e.name || e.id || "").replace(/\s+/g, " ").replace(/:$/, "").trim().slice(0, 40) };
      });
    }).catch(() => []);
    for (const si of selInfo.slice(0, 10)) {
      const label = si.label || `dropdown ${si.i + 1}`;
      await rec.run(S, `Dropdown "${label}": every option works`, screen, async () => {
        await ensureAt(page, url, opts.timeout);
        const sel = page.locator(`[data-autoqa-s="${si.i}"]`);
        if (!(await sel.count())) return { status: "skip", message: "dropdown no longer present" };
        const values = await sel.evaluate((e) => [...e.options].filter((o) => !o.disabled).map((o) => o.value));
        if (!values.length) return { status: "warn", message: "dropdown has no options" };
        const original = await sel.inputValue();
        const tried = [], notes = [];
        const mark = monitor.mark();
        for (const v of values.slice(0, 8)) {
          if (!(await sel.isVisible().catch(() => false))) { notes.push(`dropdown hidden itself after choosing "${tried[tried.length - 1]}" (layout changed)`); break; }
          await sel.selectOption(v, { timeout: 5000 });
          await settle(page);
          tried.push(v || "(empty)");
          if (normalizeUrl(page.url()) !== normalizeUrl(url)) { found.add(normalizeUrl(page.url())); notes.push(`navigates to ${pathOf(page.url())}`); break; }
        }
        if (await sel.isVisible().catch(() => false)) { await sel.selectOption(original, { timeout: 3000 }).catch(() => {}); await settle(page); }
        const { fails, warns } = monitor.classify(monitor.since(mark));
        if (fails.length) return { status: "fail", message: fails[0], evidence: [...fails, ...notes], screenshot: await ctx.shotAt(`select_${label}`) };
        return { status: warns.length ? "warn" : "pass", message: [`${tried.length}/${values.length} options tried`, ...notes].join("; "), evidence: warns };
      });
    }

    // Search / text filters
    await ensureAt(page, url, opts.timeout);
    const search = page.locator('input[type=search]:visible, input[placeholder*="search" i]:visible, input[aria-label*="search" i]:visible, input[placeholder*="filter" i]:visible');
    const sc = Math.min(await search.count(), 3);
    for (let i = 0; i < sc; i++) {
      await rec.run(S, `Search box ${i + 1}: typing and clearing works`, screen, async () => {
        await ensureAt(page, url, opts.timeout);
        const box = search.nth(i);
        const mark = monitor.mark();
        for (const q of ["a", "zzzz-no-match-123", "<script>x</script>", "' OR 1=1 --", ""]) {
          await box.fill(q, { timeout: 3000 });
          await sleep(300);
        }
        await settle(page);
        const { fails, warns } = monitor.classify(monitor.since(mark));
        if (fails.length) return { status: "fail", message: fails[0], evidence: fails };
        return { status: warns.length ? "warn" : "pass", message: "normal, no-match, HTML and SQL-like input handled", evidence: warns };
      });
    }

    // Form validation (non-destructive: uses the browser's validity API, never submits)
    await ensureAt(page, url, opts.timeout);
    const formInfo = await page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const res = [];
      const forms = [...document.querySelectorAll("form")].filter(vis);
      forms.forEach((f, idx) => {
        const fields = [...f.querySelectorAll("input, select, textarea")].filter((i) => vis(i) && !["hidden", "submit", "button", "checkbox", "radio", "file"].includes(i.type));
        if (!fields.length) return;
        if (f.querySelector("input[type=password]") && fields.length <= 2) return; // login-like form; covered by auth tests
        const saved = fields.map((i) => i.value);
        const required = fields.filter((i) => i.required || i.getAttribute("aria-required") === "true");
        fields.forEach((i) => { if (i.tagName !== "SELECT") i.value = ""; });
        const emptyBlocked = !f.checkValidity();
        const typed = [];
        for (const i of fields) {
          const bad = { email: "not-an-email", url: "not a url", number: "", tel: "" }[i.type];
          if (bad === undefined || bad === "") continue;
          i.value = bad;
          typed.push({ type: i.type, name: i.name || i.placeholder || i.type, rejected: !i.checkValidity() });
          i.value = "";
        }
        fields.forEach((i, k) => { i.value = saved[k]; });
        const heading = (f.querySelector("h1,h2,h3,legend") || {}).innerText || "";
        res.push({ idx, heading: heading.trim().slice(0, 40), fields: fields.length, required: required.length, emptyBlocked, typed, novalidate: f.noValidate });
      });
      return res;
    }).catch(() => []);
    for (const f of formInfo) {
      const fname = f.heading ? `"${f.heading}"` : `#${f.idx + 1}`;
      const ev = [`${f.fields} field(s), ${f.required} required`];
      f.typed.forEach((t) => ev.push(`${t.type} field "${t.name}" ${t.rejected ? "rejects" : "ACCEPTS"} an invalid value`));
      const badType = f.typed.filter((t) => !t.rejected);
      let status = "pass", message = "empty required fields are rejected";
      if (f.required === 0) { status = "warn"; message = f.novalidate ? "form uses custom (JS) validation — browser-level check not possible" : "no required fields: an empty form can be submitted"; }
      else if (!f.emptyBlocked) { status = "fail"; message = "required fields marked but empty form passes validation"; }
      if (badType.length) { status = status === "fail" ? "fail" : "warn"; message += `; ${badType.length} typed field(s) accept invalid input`; }
      rec.add({ suite: "Forms", screen, name: `Form ${fname}: input validation`, status, message, evidence: ev });
    }
  } finally {
    if (!opts.allowDestructive) await page.unroute("**/*", blocker).catch(() => {});
  }
  return [...found].filter(Boolean);
}

module.exports = { exploreScreen, listClickables };
