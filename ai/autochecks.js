"use strict";
/**
 * Executors for the test cases that are generated per screen (see categories.js):
 *   screen      every button / tab / dropdown / search box on a screen
 *   content     spelling & grammar (Claude) + text contrast (measured)
 *   theme       colours & fonts consistent across all screens (measured)
 *   arabic      Arabic switch, RTL layout (measured) + translation review (Claude)
 *   responsive  mobile/tablet/laptop/desktop layout (measured) + screenshot review (Claude)
 * Each returns { status: pass|fail|warn|skip, message, evidence[], screenshot }.
 */
const { Recorder } = require("../lib/recorder");
const { runScreenChecks } = require("../lib/checks");
const { exploreScreen } = require("../lib/interactions");
const { textOf } = require("./llm");
const { VIEWPORTS } = require("./categories");
const { sleep, pathOf } = require("../lib/util");

const DESKTOP = { width: 1366, height: 800 };

async function open(page, url, timeout = 30000) {
  const t0 = Date.now();
  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  await page.waitForLoadState("load", { timeout }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await sleep(300);
  return { resp, loadMs: Date.now() - t0 };
}

async function askJson(llm, system, content, schema, maxTokens = 8000) {
  const msg = await llm.create({ system, messages: [{ role: "user", content }], max_tokens: maxTokens, output_config: { format: { type: "json_schema", schema } } });
  return JSON.parse(textOf(msg));
}

const ISSUES_SCHEMA = {
  type: "object", additionalProperties: false, required: ["issues"],
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["text", "issue", "suggestion", "severity"],
        properties: {
          text: { type: "string", description: "The exact on-screen text (or element) with the problem" },
          issue: { type: "string" },
          suggestion: { type: "string" },
          severity: { type: "string", enum: ["minor", "major"] },
        },
      },
    },
  },
};

// ─────────────────────────── 1. screen & buttons ───────────────────────────
async function screenCase(tc, ctx) {
  const { page, monitor, opts } = ctx;
  const sub = new Recorder(() => {});
  const mark = monitor.mark();
  const { resp, loadMs } = await open(page, tc.url, opts.timeout);
  if (await ctx.onLoginScreen()) { await ctx.ensureLoggedIn(); }
  const shot = await ctx.shotAt(tc.screen);
  const checkOpts = { slowMs: opts.slowMs || 5000, responsive: false, maxClicks: opts.maxClicks || 25, allowDestructive: false, timeout: opts.timeout };
  await runScreenChecks(page, { rec: sub, screen: tc.screen, monitor, mark, loadMs, status: resp ? resp.status() : 0, opts: checkOpts, shot, shotAt: ctx.shotAt });
  await exploreScreen(page, { rec: sub, screen: tc.screen, monitor, opts: checkOpts, url: tc.url, origin: ctx.origin, isLoggedOut: ctx.onLoginScreen, shotAt: ctx.shotAt });
  if (await ctx.onLoginScreen()) await ctx.ensureLoggedIn();
  const relevant = sub.tests.filter((t) => t.suite !== "Accessibility");
  const fails = relevant.filter((t) => t.status === "fail");
  const warns = relevant.filter((t) => t.status === "warn");
  const controls = relevant.filter((t) => t.suite === "Interactions" && /^(Click|Dropdown|Search)/.test(t.name));
  const line = (t) => `${t.status.toUpperCase()} · ${t.name}${t.message ? " — " + t.message : ""}`;
  return {
    status: fails.length ? "fail" : warns.length ? "warn" : "pass",
    message: fails.length ? `${fails.length} problem(s): ${fails[0].name} — ${fails[0].message}` : `${controls.length} controls exercised, page checks clean${warns.length ? ` (${warns.length} warning(s))` : ""}`,
    evidence: [...fails.map(line), ...warns.map(line), ...relevant.filter((t) => t.status === "pass").map(line), ...relevant.filter((t) => t.status === "skip").map(line)],
    screenshot: fails.find((t) => t.screenshot)?.screenshot || shot,
  };
}

// ─────────────────────────── 2. content & theme ───────────────────────────
async function collectText(page) {
  return page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
    const seen = new Set(); const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode; const t = n.textContent.replace(/\s+/g, " ").trim();
      if (!t || t.length < 2 || seen.has(t) || !n.parentElement || !vis(n.parentElement)) continue;
      if (/^(SCRIPT|STYLE|NOSCRIPT)$/.test(n.parentElement.tagName)) continue;
      seen.add(t); out.push(t);
    }
    document.querySelectorAll("input[placeholder], textarea[placeholder], [title], [aria-label], img[alt]").forEach((e) => {
      if (!vis(e)) return;
      for (const t of [e.getAttribute("placeholder"), e.getAttribute("title"), e.getAttribute("aria-label"), e.getAttribute("alt")]) if (t && !seen.has(t.trim())) { seen.add(t.trim()); out.push(t.trim()); }
    });
    return out.slice(0, 600);
  });
}

async function measureContrast(page) {
  return page.evaluate(() => {
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }; };
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.backgroundImage && s.backgroundImage !== "none") return null; const c = parse(s.backgroundColor); if (c && c.a > 0.9) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
    const bad = []; let checked = 0;
    for (const el of document.body.querySelectorAll("*")) {
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim();
      if (!own || own.length < 2) continue;
      const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || s.visibility === "hidden" || s.display === "none" || Number(s.opacity) < 0.3) continue;
      if (el.closest("button[disabled], [aria-disabled=true], input[disabled]")) continue;
      const fg = parse(s.color); const bg = bgOf(el); if (!fg || !bg) continue;
      checked++;
      const L1 = lum(fg), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const size = parseFloat(s.fontSize); const bold = Number(s.fontWeight) >= 700;
      const large = size >= 24 || (bold && size >= 18.66);
      const need = large ? 3 : 4.5;
      if (ratio < need) {
        const key = own.slice(0, 50) + "|" + s.color;
        const prev = bad.find((b) => b.key === key);
        if (prev) prev.count++; else bad.push({ key, text: own.slice(0, 50), ratio: Math.round(ratio * 100) / 100, need, color: s.color, size: Math.round(size), count: 1 });
      }
    }
    return { checked, bad: bad.sort((a, b) => a.ratio - b.ratio).slice(0, 40) };
  });
}

const PROOF_SYSTEM = `You are a meticulous proofreader and UX-copy reviewer for a business web application. You receive every piece of visible text from one screen (headings, labels, buttons, table headers, messages, placeholders, tooltips).
Report real problems only: spelling mistakes, grammar errors, wrong words, inconsistent capitalisation or terminology within the screen, truncated or garbled text, placeholder/lorem ipsum text, raw technical strings shown to users (e.g. "undefined", "null", "error_code_42", "TODO").
Do NOT report: person, company, product or place names; codes and IDs; units and abbreviations; numbers and dates; emoji; intentional brand spellings; British vs American spelling unless mixed on the same screen.
severity: "major" for spelling mistakes, wrong words and raw technical strings users would notice; "minor" for style and consistency. Return an empty list if the text is clean.`;

async function contentCase(tc, ctx) {
  const { page, llm } = ctx;
  await open(page, tc.url, ctx.opts.timeout);
  const shot = await ctx.shotAt(`content_${tc.screen}`);
  const texts = await collectText(page);
  const contrast = await measureContrast(page);
  let issues = [];
  if (llm && texts.length) issues = (await askJson(llm, PROOF_SYSTEM, `SCREEN ${tc.screen}\nVISIBLE TEXT (one item per line):\n${texts.join("\n")}`, ISSUES_SCHEMA)).issues;
  const major = issues.filter((i) => i.severity === "major");
  const unreadable = contrast.bad.filter((b) => b.ratio < 3);
  const ev = [
    ...issues.map((i) => `${i.severity.toUpperCase()} text: "${i.text}" — ${i.issue}${i.suggestion ? ` → "${i.suggestion}"` : ""}`),
    `Contrast: ${contrast.checked} text elements measured, ${contrast.bad.length} below WCAG AA`,
    ...contrast.bad.map((b) => `Low contrast ${b.ratio}:1 (needs ${b.need}:1) — "${b.text}"${b.count > 1 ? ` ×${b.count}` : ""} (${b.size}px, ${b.color})`),
  ];
  const status = major.length || unreadable.length ? "fail" : issues.length || contrast.bad.length ? "warn" : "pass";
  const parts = [];
  if (issues.length) parts.push(`${issues.length} text issue(s)${major.length ? ` (${major.length} spelling/wording errors)` : ""}`);
  if (contrast.bad.length) parts.push(`${contrast.bad.length} low-contrast text element(s)${unreadable.length ? `, ${unreadable.length} hard to read` : ""}`);
  return { status, message: parts.join("; ") || `${texts.length} text items proofread, contrast OK`, evidence: ev, screenshot: shot };
}

async function themeCase(tc, ctx) {
  const { page, screens } = ctx;
  const samples = [];
  for (const s of screens) {
    await open(page, s.url, ctx.opts.timeout);
    samples.push({ path: s.path, ...(await page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const first = (sel, prop) => { const el = [...document.querySelectorAll(sel)].find(vis); return el ? getComputedStyle(el)[prop] : ""; };
      const all = (sel, prop) => [...new Set([...document.querySelectorAll(sel)].filter(vis).map((e) => getComputedStyle(e)[prop]))];
      const font = (f) => (f || "").split(",")[0].replace(/["']/g, "").trim();
      return {
        background: getComputedStyle(document.body).backgroundColor,
        bodyFont: font(getComputedStyle(document.body).fontFamily),
        bodyColor: getComputedStyle(document.body).color,
        headingFont: font(first("h1, h2", "fontFamily")),
        headingColor: first("h1", "color") || first("h2", "color"),
        linkColor: first("main a[href], .content a[href], p a[href]", "color"),
        buttonColors: all("button:not([disabled]), .btn, [role=button]", "backgroundColor").filter((c) => !/rgba\(0, 0, 0, 0\)|transparent/.test(c)),
      };
    })) });
  }
  const roles = ["background", "bodyFont", "bodyColor", "headingFont", "headingColor", "linkColor"];
  const ev = []; let deviations = 0;
  for (const role of roles) {
    const counts = {};
    samples.forEach((s) => { if (s[role]) counts[s[role]] = (counts[s[role]] || 0) + 1; });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (!sorted.length) continue;
    const [main, n] = sorted[0];
    ev.push(`${role}: ${main} on ${n}/${samples.length} screens`);
    if (sorted.length > 1 && n / samples.length >= 0.6) {
      for (const s of samples.filter((x) => x[role] && x[role] !== main)) { deviations++; ev.push(`  ✗ ${s.path} uses ${role} ${s[role]} (rest of the app: ${main})`); }
    }
  }
  const palette = [...new Set(samples.flatMap((s) => s.buttonColors))];
  ev.push(`Button colours used across the app (${palette.length}): ${palette.join(", ")}`);
  const status = deviations ? "fail" : palette.length > 6 ? "warn" : "pass";
  return { status, message: deviations ? `${deviations} screen element style(s) differ from the app's theme` : palette.length > 6 ? `Consistent, but ${palette.length} different button colours are used` : `Theme and fonts consistent across ${samples.length} screens`, evidence: ev, screenshot: "" };
}

// ─────────────────────────── 3. Arabic ───────────────────────────
async function arabicRatio(page) {
  return page.evaluate(() => {
    const t = document.body.innerText || "";
    const ar = (t.match(/[؀-ۿ]/g) || []).length; const lat = (t.match(/[A-Za-z]/g) || []).length;
    return { ratio: ar / Math.max(1, ar + lat), dir: document.documentElement.dir || document.body.dir || getComputedStyle(document.body).direction, lang: document.documentElement.lang || "" };
  });
}

async function switchToArabic(ctx) {
  const { page, opts } = ctx;
  const st = ctx.state.arabic;
  if (st.tried) return st;
  st.tried = true;
  const home = ctx.screens[0] ? ctx.screens[0].url : ctx.baseUrl;
  const isArabic = async () => (await arabicRatio(page)).ratio > 0.25;
  // 1. URL given by the user
  if (opts.arabicUrl) {
    st.mapUrl = (u) => arabicUrlFor(u, opts.arabicUrl, ctx.baseUrl);
    await open(page, st.mapUrl(home), opts.timeout);
    if (await isArabic()) { st.available = true; st.how = `Arabic URL ${opts.arabicUrl}`; return st; }
  }
  // 2. a language switch on the page
  await open(page, home, opts.timeout);
  const AR = /العربية|عربي|arabic|^\s*ar\s*$|^\s*ع\s*$/i;
  const sel = await page.evaluate((src) => {
    const re = new RegExp(src, "i");
    for (const s of document.querySelectorAll("select")) { const o = [...s.options].find((x) => re.test(x.text) || /^ar(-|$)/i.test(x.value)); if (o) { s.setAttribute("data-qa-lang", "1"); return { type: "select", value: o.value }; } }
    const el = [...document.querySelectorAll('a, button, [role=button], [role=menuitem], [role=option], li, span')].find((e) => { const t = (e.innerText || e.getAttribute("aria-label") || e.title || "").trim(); return t && t.length < 20 && re.test(t) || /^ar(-|$)/i.test(e.getAttribute("hreflang") || e.getAttribute("lang") || ""); });
    if (el) { el.setAttribute("data-qa-lang", "1"); return { type: "click", text: (el.innerText || "").trim() }; }
    return null;
  }, AR.source).catch(() => null);
  if (sel) {
    try {
      if (sel.type === "select") await page.selectOption("[data-qa-lang]", sel.value);
      else await page.click("[data-qa-lang]", { timeout: 5000 });
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      await sleep(500);
      if (await isArabic()) { st.available = true; st.how = `language switch "${sel.text || sel.value}"`; st.mapUrl = (u) => u; return st; }
    } catch { /* fall through */ }
  }
  // 3. common URL conventions
  for (const guess of ["?lang=ar", "?locale=ar", "?language=ar", "/ar"]) {
    const map = (u) => arabicUrlFor(u, guess, ctx.baseUrl);
    await open(page, map(home), opts.timeout).catch(() => {});
    if (await isArabic()) { st.available = true; st.how = `URL convention ${guess}`; st.mapUrl = map; return st; }
  }
  st.available = false;
  return st;
}

/** Turn a screen URL into its Arabic URL, given "?lang=ar", "/ar" or a full Arabic base URL. */
function arabicUrlFor(url, hint, baseUrl) {
  const u = new URL(url);
  if (/^\?/.test(hint) || (/^https?:/.test(hint) && new URL(hint).search)) {
    const q = new URLSearchParams(/^\?/.test(hint) ? hint : new URL(hint).search);
    q.forEach((v, k) => u.searchParams.set(k, v));
    return u.toString();
  }
  const prefix = /^https?:/.test(hint) ? new URL(hint).pathname.replace(/\/$/, "") : hint.replace(/\/$/, "");
  if (prefix && !u.pathname.startsWith(prefix + "/") && u.pathname !== prefix) u.pathname = prefix + (u.pathname === "/" ? "" : u.pathname);
  return u.toString();
}

const ARABIC_SYSTEM = `You are a native Arabic (Modern Standard Arabic) localisation reviewer for business web applications. You receive the visible text of one screen after the app was switched to Arabic, plus the list of Latin-script strings still on the screen.
Report: English/Latin text that should have been translated (labels, buttons, headings, messages — NOT brand names, product names, person names, codes, units, emails, URLs); Arabic spelling or grammar mistakes; mistranslations or unnatural, machine-like wording; wrong gender/number agreement; mixed-direction strings that would display in the wrong order; Western vs Eastern digits used inconsistently on the same screen.
severity "major" for untranslated UI labels, wrong meaning, or broken text; "minor" for style. Write suggestions in Arabic. Return an empty list if everything is correct.`;

async function arabicCase(tc, ctx) {
  const { page, llm, opts } = ctx;
  const st = await switchToArabic(ctx);
  if (!st.available) {
    const msg = "No Arabic version found: no language switch (العربية / Arabic / AR), and /ar or ?lang=ar did not show Arabic. If the app has Arabic, enter its Arabic URL under Advanced options.";
    return { status: tc.arabicStep === "switch" ? "fail" : "skip", message: msg, evidence: [msg], screenshot: tc.arabicStep === "switch" ? await ctx.shotAt("arabic_not_found") : "" };
  }
  if (tc.arabicStep === "switch") {
    const r = await arabicRatio(page);
    return { status: "pass", message: `Arabic available via ${st.how} (${Math.round(r.ratio * 100)}% Arabic text, dir=${r.dir}, lang=${r.lang || "not set"})`, evidence: [`Switched using ${st.how}`], screenshot: await ctx.shotAt("arabic_home") };
  }
  await open(page, st.mapUrl(tc.url), opts.timeout);
  let r = await arabicRatio(page);
  const ev = [`Opened ${pathOf(page.url())}`, `Arabic text share ${Math.round(r.ratio * 100)}%, direction ${r.dir}, lang="${r.lang}"`];
  const fails = [], warns = [];
  if (r.ratio < 0.25) fails.push("Screen is not shown in Arabic (the language did not stay switched)");
  if (r.dir !== "rtl") fails.push(`Page direction is "${r.dir}", not right-to-left (dir="rtl")`);
  const layout = await page.evaluate(() => {
    const leftAligned = [...document.querySelectorAll("p, li, td, th, label, h1, h2, h3")].filter((e) => { const s = getComputedStyle(e); const t = (e.innerText || "").trim(); return t && /[؀-ۿ]/.test(t) && (s.textAlign === "left" || (s.direction === "ltr")); }).length;
    return { overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 4, leftAligned };
  });
  if (layout.overflow) fails.push("Page scrolls horizontally in Arabic (layout breaks in RTL)");
  if (layout.leftAligned > 3) warns.push(`${layout.leftAligned} Arabic text blocks are left-aligned / LTR`);
  const texts = await collectText(page);
  const latin = texts.filter((t) => /[A-Za-z]{3,}/.test(t) && !/^[\w.+-]+@[\w.-]+$/.test(t) && !/^https?:/.test(t));
  ev.push(`Latin-script strings still visible (${latin.length}): ${latin.slice(0, 30).join(" | ")}`);
  let issues = [];
  if (llm) issues = (await askJson(llm, ARABIC_SYSTEM, `SCREEN ${tc.screen}\nVISIBLE TEXT:\n${texts.join("\n")}\n\nLATIN-SCRIPT STRINGS:\n${latin.join("\n") || "(none)"}`, ISSUES_SCHEMA)).issues;
  issues.forEach((i) => (i.severity === "major" ? fails : warns).push(`"${i.text}" — ${i.issue}${i.suggestion ? ` → ${i.suggestion}` : ""}`));
  const shot = await ctx.shotAt(`arabic_${tc.screen}`);
  return { status: fails.length ? "fail" : warns.length ? "warn" : "pass", message: fails[0] || warns[0] || "Arabic layout and translation correct", evidence: [...fails.map((f) => "FAIL · " + f), ...warns.map((w) => "WARN · " + w), ...ev], screenshot: shot };
}

// ─────────────────────────── 6. responsive ───────────────────────────
async function layoutProblems(page, mobile) {
  return page.evaluate((mobile) => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.1; };
    const desc = (e) => `<${e.tagName.toLowerCase()}> "${(e.innerText || e.value || e.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 30)}"`;
    const vw = document.documentElement.clientWidth;
    const out = { overflowPx: Math.max(0, document.documentElement.scrollWidth - vw), offscreen: [], overlaps: [], smallText: 0, smallTextSample: [], smallTargets: [], clipped: [] };
    const scrollParent = (e) => { for (let p = e.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === "auto" || o === "scroll") return true; } return false; };
    for (const e of document.body.querySelectorAll("*")) {
      if (!vis(e)) continue;
      const r = e.getBoundingClientRect();
      if (r.right > vw + 2 && r.left < vw && getComputedStyle(e).position !== "fixed" && !scrollParent(e) && out.offscreen.length < 8 && !e.querySelector("*:not(svg *)")) out.offscreen.push(desc(e));
      const own = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
      if (own) {
        const fs = parseFloat(getComputedStyle(e).fontSize);
        if (mobile && fs < 12) { out.smallText++; if (out.smallTextSample.length < 5) out.smallTextSample.push(`${desc(e)} ${fs}px`); }
        const s = getComputedStyle(e);
        if ((s.overflow === "hidden" || s.textOverflow === "ellipsis") && e.scrollWidth > e.clientWidth + 2 && out.clipped.length < 8) out.clipped.push(desc(e));
      }
    }
    const ctrls = [...document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, [role=button]")].filter(vis).slice(0, 200);
    if (mobile) for (const c of ctrls) { const r = c.getBoundingClientRect(); if ((r.width < 32 || r.height < 32) && !c.closest("p, li p, td") && out.smallTargets.length < 10) out.smallTargets.push(`${desc(c)} ${Math.round(r.width)}×${Math.round(r.height)}px`); }
    for (let i = 0; i < ctrls.length; i++) for (let j = i + 1; j < ctrls.length; j++) {
      const a = ctrls[i], b = ctrls[j]; if (a.contains(b) || b.contains(a)) continue;
      const A = a.getBoundingClientRect(), B = b.getBoundingClientRect();
      const w = Math.min(A.right, B.right) - Math.max(A.left, B.left), h = Math.min(A.bottom, B.bottom) - Math.max(A.top, B.top);
      if (w > 4 && h > 4 && w * h > 0.3 * Math.min(A.width * A.height, B.width * B.height) && out.overlaps.length < 8) out.overlaps.push(`${desc(a)} overlaps ${desc(b)}`);
    }
    return out;
  }, mobile);
}

const UX_SYSTEM = `You are a senior UI/UX reviewer. You get screenshots of one screen of a business web app at mobile and tablet sizes. Report concrete visual and usability problems a user would notice: content cut off or overflowing, overlapping elements, cramped or misaligned layout, unreadable text, tables or charts unusable at that size, navigation that hides the content or can't be reached, controls too small or too close to tap, broken images, poor spacing or inconsistent alignment.
Do not report matters of taste. Mention the size (Mobile/Tablet) in the text field. severity "major" if it blocks or seriously hinders use at that size, otherwise "minor". Return an empty list if the layout works well.`;

async function responsiveCase(tc, ctx) {
  const { page, llm, opts } = ctx;
  const ev = []; const fails = [], warns = []; const images = []; let firstShot = "";
  try {
    for (const v of VIEWPORTS) {
      await page.setViewportSize({ width: v.width, height: v.height });
      await open(page, tc.url, opts.timeout);
      const mobile = v.width < 600, small = v.width < 1000;
      const p = await layoutProblems(page, mobile);
      const shot = await ctx.shotAt(`${tc.screen}_${v.name}`);
      if (!firstShot) firstShot = shot;
      const tag = `${v.name} ${v.width}px`;
      if (p.overflowPx > 4) fails.push(`${tag}: page is ${p.overflowPx}px wider than the screen (horizontal scrolling)${p.offscreen.length ? ` — e.g. ${p.offscreen.slice(0, 3).join(", ")}` : ""}`);
      p.overlaps.forEach((o) => fails.push(`${tag}: ${o}`));
      if (p.smallText > 3) warns.push(`${tag}: ${p.smallText} text elements smaller than 12px (e.g. ${p.smallTextSample.slice(0, 3).join(", ")})`);
      if (p.smallTargets.length > 2) warns.push(`${tag}: ${p.smallTargets.length} tap targets smaller than 32px (e.g. ${p.smallTargets.slice(0, 3).join(", ")})`);
      if (p.clipped.length) warns.push(`${tag}: text cut off in ${p.clipped.slice(0, 3).join(", ")}`);
      ev.push(`${tag}: overflow ${p.overflowPx}px, ${p.overlaps.length} overlaps, ${p.smallText} small texts, ${p.smallTargets.length} small targets — screenshot ${shot}`);
      if (small && llm) images.push({ v, data: (await page.screenshot({ type: "jpeg", quality: 55, fullPage: true })).toString("base64") });
    }
    if (llm && images.length) {
      const content = [];
      for (const im of images) { content.push({ type: "text", text: `${im.v.name} (${im.v.width}×${im.v.height}):` }); content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: im.data } }); }
      content.push({ type: "text", text: `Screen ${tc.screen}. Review these screenshots.` });
      const r = await askJson(llm, UX_SYSTEM, content, ISSUES_SCHEMA);
      r.issues.forEach((i) => (i.severity === "major" ? fails : warns).push(`UX review: ${i.text} — ${i.issue}${i.suggestion ? ` → ${i.suggestion}` : ""}`));
    }
  } finally {
    await page.setViewportSize(DESKTOP);
  }
  return { status: fails.length ? "fail" : warns.length ? "warn" : "pass", message: fails[0] || warns[0] || `Layout works on ${VIEWPORTS.map((v) => v.name).join(", ")}`, evidence: [...fails.map((f) => "FAIL · " + f), ...warns.map((w) => "WARN · " + w), ...ev], screenshot: firstShot };
}

async function runAutoCase(tc, ctx) {
  await ctx.ensureLoggedIn();
  const fn = { screen: screenCase, content: contentCase, theme: themeCase, arabic: arabicCase, responsive: responsiveCase }[tc.executor];
  if (!fn) return { status: "skip", message: `Unknown executor ${tc.executor}`, evidence: [] };
  try { return await fn(tc, ctx); } catch (e) { return { status: "fail", message: `Check could not complete: ${e.message.split("\n")[0]}`, evidence: [], screenshot: await ctx.shotAt(`error_${tc.id}`) }; }
}

module.exports = { runAutoCase, arabicUrlFor };
