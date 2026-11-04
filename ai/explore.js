"use strict";
/**
 * Phase 1 — EXPLORE. Walks the app like a new user: visits every reachable
 * screen and opens "Add / New / Create / Edit…" forms to learn what data the
 * app manages. Nothing is saved: every POST/PUT/PATCH/DELETE is blocked while
 * exploring and forms are never submitted.
 * Output: an "app map" — one entry per screen with its text snapshot and the
 * forms that its buttons open.
 */
const { normalizeUrl, pathOf, SKIP_URL, DOWNLOAD_EXT, sleep } = require("../lib/util");
const { snapshot } = require("./snapshot");

const OPENER = /^(\+\s*)?(add|new|create|edit|invite|register|upload|import|connect|compose|book|schedule|assign|open|view|details?|manage|configure|\+)\b/i;

async function settle(page) {
  await sleep(250);
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  await sleep(150);
}

async function explore(page, { origin, startUrl, maxPages = 25, timeout = 30000, isLoginUrl, log = console.log }) {
  const blocker = (route) => {
    const r = route.request();
    if (["POST", "PUT", "PATCH", "DELETE"].includes(r.method()) && r.url().startsWith(origin)) return route.abort("blockedbyclient");
    return route.fallback();
  };
  await page.route("**/*", blocker);
  const queue = [normalizeUrl(startUrl, origin)];
  const seen = new Set(queue);
  const perPath = new Map();
  const screens = [];
  try {
    while (queue.length && screens.length < maxPages) {
      const url = queue.shift();
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout });
        await settle(page);
      } catch (e) { log(`  ! could not open ${pathOf(url)}: ${e.message.split("\n")[0]}`); continue; }
      const final = normalizeUrl(page.url(), origin);
      if (isLoginUrl(final)) continue;
      if (final !== url && screens.some((s) => s.url === final)) continue;
      seen.add(final);
      const snap = await snapshot(page, { maxChars: 6000, maxRows: 5 });
      const screen = { url: final, path: pathOf(final), title: snap.title, snapshot: snap.text, opens: [] };
      log(`  • screen ${screens.length + 1}: ${screen.path}`);

      // links → more screens
      const links = await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => a.href)).catch(() => []);
      for (const l of links) {
        const n = normalizeUrl(l, origin);
        if (!n || !n.startsWith(origin) || seen.has(n) || SKIP_URL.test(n) || DOWNLOAD_EXT.test(n) || isLoginUrl(n)) continue;
        const p = new URL(n).pathname; const c = perPath.get(p) || 0;
        if (c >= 2) continue;
        perPath.set(p, c + 1); seen.add(n); queue.push(n);
      }

      // open forms/dialogs behind "Add / New / Edit…" buttons (first of each label only)
      const openers = await page.evaluate((src) => {
        const re = new RegExp(src, "i");
        const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const seenLabels = new Set(); const out = [];
        for (const el of document.querySelectorAll('button, [role=button], a:not([href]), [role=tab]')) {
          const t = (el.getAttribute("aria-label") || el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 40);
          const core = t.replace(/^[^\p{L}\p{N}+]+/u, ""); // ignore leading icons/emoji
          if (!vis(el) || el.disabled || !t || !re.test(core) || seenLabels.has(t.toLowerCase())) continue;
          seenLabels.add(t.toLowerCase()); out.push(t);
        }
        return out.slice(0, 6);
      }, OPENER.source).catch(() => []);
      for (const label of openers) {
        try {
          await page.goto(final, { waitUntil: "domcontentloaded", timeout });
          await settle(page);
          const before = await snapshot(page, { maxChars: 6000, maxRows: 3 });
          const btn = page.getByRole("button", { name: label, exact: true }).or(page.getByRole("tab", { name: label, exact: true })).first();
          if (!(await btn.count())) continue;
          await btn.click({ timeout: 4000 });
          await settle(page);
          const after = await snapshot(page, { maxChars: 4000, maxRows: 3 });
          const nav = normalizeUrl(page.url(), origin);
          if (nav !== final && nav && nav.startsWith(origin) && !seen.has(nav) && !isLoginUrl(nav)) { seen.add(nav); queue.unshift(nav); }
          if (after.text !== before.text) screen.opens.push({ button: label, result: after.dialogOpen || nav !== final ? after.text : diffControls(before.text, after.text) });
          await page.keyboard.press("Escape").catch(() => {});
        } catch { /* control not clickable — ignore */ }
      }
      screens.push(screen);
    }
  } finally {
    await page.unroute("**/*", blocker).catch(() => {});
  }
  return { screens, notVisited: queue.map(pathOf) };
}

/** Lines of the CONTROLS/MESSAGES sections that changed after a click (form appeared in-page). */
function diffControls(before, after) {
  const b = new Set(before.split("\n").map((l) => l.replace(/\[e\d+\]/g, "")));
  const changed = after.split("\n").filter((l) => !b.has(l.replace(/\[e\d+\]/g, "")) && !/^VISIBLE TEXT/.test(l));
  return changed.length ? `(screen changed in place)\n${changed.join("\n")}` : "(no visible change)";
}

/** App map → compact text for the planner. */
function appMapText(map, maxChars = 180000) {
  let out = "";
  for (const s of map.screens) {
    out += `\n=== SCREEN ${s.path} ===\n${s.snapshot}\n`;
    for (const o of s.opens) out += `--- after clicking "${o.button}" ---\n${o.result}\n`;
  }
  if (out.length > maxChars) out = out.slice(0, maxChars) + "\n… (app map truncated)";
  return out;
}

module.exports = { explore, appMapText };
