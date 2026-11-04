"use strict";
/** Per-screen UI checks: content, error text, images, accessibility, responsive layout. */

const ERROR_TEXT = /(Application error|Internal Server Error|Unhandled Runtime Error|Server Error|Something went wrong|This page could not be found|Page not found|404 Not Found|Cannot (GET|POST) \/|Traceback \(most recent call last\)|Exception in thread|Stack trace:|Fatal error|Bad Gateway|Service Unavailable|Gateway Timeout|An error occurred)/i;
const DATA_GLITCH = /(\bNaN\b|\bundefined\b|\[object Object\]|Invalid Date)/;

/** Snapshot of everything we want to know about the rendered DOM, in one round-trip. */
async function inspectDom(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const name = (el) => (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.getAttribute("title") || el.innerText || el.value || el.getAttribute("alt") || (el.querySelector("img[alt],svg title") || {}).textContent || "").trim();
    const text = document.body ? document.body.innerText || "" : "";
    const imgs = [...document.images].filter(vis);
    const brokenImgs = imgs.filter((i) => i.complete && i.naturalWidth === 0 && !!i.currentSrc).map((i) => i.currentSrc);
    const noAlt = imgs.filter((i) => !i.hasAttribute("alt")).map((i) => i.currentSrc || i.src);
    const inputs = [...document.querySelectorAll("input, select, textarea")].filter((i) => vis(i) && !["hidden", "submit", "button", "reset", "image"].includes(i.type));
    const unlabeled = inputs.filter((i) => {
      if (i.getAttribute("aria-label") || i.getAttribute("aria-labelledby") || i.getAttribute("title")) return false;
      if (i.id && document.querySelector(`label[for="${CSS.escape(i.id)}"]`)) return false;
      if (i.closest("label")) return false;
      return true;
    }).map((i) => `<${i.tagName.toLowerCase()} name="${i.name || ""}" placeholder="${i.placeholder || ""}">`);
    const nameless = [...document.querySelectorAll("button, a[href], [role=button]")].filter((b) => vis(b) && !name(b)).map((b) => b.outerHTML.slice(0, 120));
    const ids = {};
    document.querySelectorAll("[id]").forEach((e) => { ids[e.id] = (ids[e.id] || 0) + 1; });
    const dupIds = Object.keys(ids).filter((k) => ids[k] > 1);
    const visibleEls = [...document.body.querySelectorAll("*")].filter(vis).length;
    return {
      title: document.title,
      lang: document.documentElement.getAttribute("lang") || "",
      textLen: text.trim().length,
      text: text.slice(0, 20000),
      visibleEls,
      h1: document.querySelectorAll("h1").length,
      brokenImgs, noAlt, unlabeled, nameless, dupIds,
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      tables: document.querySelectorAll("table").length,
      forms: document.querySelectorAll("form").length,
      charts: document.querySelectorAll("canvas, svg.recharts-surface, .highcharts-container, .apexcharts-canvas, svg[class*=chart]").length,
    };
  });
}

function findLines(text, re, max = 5) {
  return text.split("\n").filter((l) => re.test(l)).map((l) => l.trim().slice(0, 160)).slice(0, max);
}

/**
 * Run all static checks on a loaded screen. `ctx` = { rec, screen, monitor, mark, loadMs, status, opts, shot }
 */
async function runScreenChecks(page, ctx) {
  const { rec, screen, monitor, mark, loadMs, status, opts } = ctx;
  const S = "Screen";
  const dom = await inspectDom(page);

  rec.add({ suite: S, screen, name: "Page loads (HTTP status)", status: status && status >= 400 ? "fail" : "pass", message: `HTTP ${status || "n/a (client-side route)"}`, screenshot: ctx.shot });

  rec.add({ suite: S, screen, name: "Load time", status: loadMs > opts.slowMs * 3 ? "fail" : loadMs > opts.slowMs ? "warn" : "pass", message: `${loadMs} ms (threshold ${opts.slowMs} ms)` });

  const { fails, warns } = monitor.classify(monitor.since(mark));
  rec.add({ suite: S, screen, name: "No JavaScript / console / network errors", status: fails.length ? "fail" : warns.length ? "warn" : "pass", message: fails.length ? `${fails.length} error(s)` : warns.length ? `${warns.length} warning(s)` : "clean", evidence: [...fails, ...warns] });

  rec.add({ suite: S, screen, name: "Screen renders content (not blank)", status: dom.textLen < 10 && dom.visibleEls < 5 ? "fail" : "pass", message: `${dom.textLen} chars of text, ${dom.visibleEls} visible elements, ${dom.tables} tables, ${dom.charts} charts, ${dom.forms} forms` });

  const errLines = findLines(dom.text, ERROR_TEXT);
  rec.add({ suite: S, screen, name: "No error messages shown on screen", status: errLines.length ? "fail" : "pass", message: errLines.length ? `Found: "${errLines[0]}"` : "", evidence: errLines });

  const glitch = findLines(dom.text, DATA_GLITCH);
  rec.add({ suite: S, screen, name: "Data renders correctly (no NaN/undefined/[object Object])", status: glitch.length ? "fail" : "pass", evidence: glitch, message: glitch.length ? `Found: "${glitch[0]}"` : "" });

  rec.add({ suite: S, screen, name: "Images load", status: dom.brokenImgs.length ? "fail" : "pass", evidence: dom.brokenImgs, message: dom.brokenImgs.length ? `${dom.brokenImgs.length} broken image(s)` : "" });

  rec.add({ suite: S, screen, name: "Has page title", status: dom.title.trim() ? "pass" : "warn", message: dom.title || "empty <title>" });

  const a11y = [];
  if (!dom.lang) a11y.push("<html> has no lang attribute");
  if (!dom.h1) a11y.push("No <h1> heading on screen");
  dom.noAlt.forEach((s) => a11y.push(`Image without alt: ${s}`));
  dom.unlabeled.forEach((s) => a11y.push(`Form field without label: ${s}`));
  dom.nameless.forEach((s) => a11y.push(`Button/link without accessible name: ${s}`));
  dom.dupIds.forEach((s) => a11y.push(`Duplicate id="${s}"`));
  rec.add({ suite: "Accessibility", screen, name: "Basic accessibility (labels, alt text, names, lang, headings)", status: a11y.length ? "warn" : "pass", message: a11y.length ? `${a11y.length} issue(s)` : "", evidence: a11y });

  if (opts.responsive) {
    for (const vp of [{ n: "Mobile 375px", w: 375, h: 812 }, { n: "Tablet 768px", w: 768, h: 1024 }]) {
      await rec.run("Responsive", `Layout fits ${vp.n} (no horizontal scroll)`, screen, async () => {
        const orig = page.viewportSize();
        await page.setViewportSize({ width: vp.w, height: vp.h });
        await page.waitForTimeout(400);
        const m = await page.evaluate(() => {
          const over = [...document.body.querySelectorAll("*")].filter((e) => {
            const r = e.getBoundingClientRect(); return r.right > window.innerWidth + 2 && r.width > 0 && getComputedStyle(e).position !== "fixed";
          });
          // elements whose overflow is clipped by a scroll container are fine
          const leaking = over.filter((e) => { let p = e.parentElement; while (p) { const o = getComputedStyle(p).overflowX; if (o === "auto" || o === "scroll" || o === "hidden") return false; p = p.parentElement; } return true; });
          return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sample: leaking.slice(0, 5).map((e) => `<${e.tagName.toLowerCase()} class="${(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className) || ""}">`) };
        });
        const shot = await ctx.shotAt(`${vp.w}`);
        await page.setViewportSize(orig);
        await page.waitForTimeout(200);
        if (m.sw > m.cw + 4) return { status: "warn", message: `Page is ${m.sw}px wide on a ${m.cw}px screen`, evidence: m.sample, screenshot: shot };
        return { screenshot: shot };
      });
    }
  }
  return dom;
}

module.exports = { runScreenChecks, inspectDom, ERROR_TEXT };
