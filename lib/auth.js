"use strict";
/**
 * Generic login handling. Works with most username/email + password forms,
 * including two-step logins (username → Next → password).
 */
const { sleep, LOGOUT_TEXT } = require("./util");

/** Tag the login form fields in the page with data-autoqa attributes. */
async function tagLoginForm(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    document.querySelectorAll("[data-autoqa]").forEach((e) => e.removeAttribute("data-autoqa"));
    const pass = [...document.querySelectorAll("input[type=password]")].find(vis) || null;
    const scope = (pass && (pass.closest("form") || pass.closest("[role=dialog]"))) || document;
    const inputs = [...scope.querySelectorAll("input")].filter((i) => vis(i) && !["hidden", "password", "checkbox", "radio", "submit", "button", "file"].includes(i.type));
    const userish = (i) => /user|email|login|account|phone|mobile|id/i.test([i.name, i.id, i.type, i.autocomplete, i.placeholder, i.getAttribute("aria-label")].join(" "));
    let user = inputs.find(userish) || null;
    if (!user && pass) {
      // nearest text input before the password field
      const before = inputs.filter((i) => i.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING);
      user = before[before.length - 1] || null;
    }
    if (!user && !pass) user = null;
    const btns = [...scope.querySelectorAll("button, input[type=submit], [role=button]")].filter(vis);
    const txt = (b) => (b.innerText || b.value || b.getAttribute("aria-label") || "").trim();
    const submit =
      btns.find((b) => /^(log ?in|sign ?in|continue|next|submit|enter|go)\b/i.test(txt(b))) ||
      btns.find((b) => b.type === "submit") ||
      btns.find((b) => /log ?in|sign ?in/i.test(txt(b))) || null;
    if (user) user.setAttribute("data-autoqa", "user");
    if (pass) pass.setAttribute("data-autoqa", "pass");
    if (submit) submit.setAttribute("data-autoqa", "submit");
    return { user: !!user, pass: !!pass, submit: !!submit };
  });
}

async function hasPasswordField(page) {
  try {
    return await page.evaluate(() => [...document.querySelectorAll("input[type=password]")].some((el) => {
      const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
    }));
  } catch { return false; }
}

/** A screen whose main purpose is logging in: password field + at most 2 other text fields. */
async function looksLikeLoginForm(page) {
  try {
    return await page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const pw = [...document.querySelectorAll("input[type=password]")].filter(vis);
      if (!pw.length) return false;
      const others = [...document.querySelectorAll("input, select, textarea")].filter((i) => vis(i) && !["hidden", "password", "checkbox", "radio", "submit", "button"].includes(i.type));
      return pw.length <= 2 && others.length <= 2;
    });
  } catch { return false; }
}

/** Visible error text near a form (role=alert, .error, .invalid ...). */
async function visibleErrorText(page) {
  try {
    return await page.evaluate(() => {
      const els = [...document.querySelectorAll('[role=alert], .error, .alert, .alert-danger, .invalid-feedback, .text-danger, .error-message, [aria-live]')];
      return els.map((e) => (e.innerText || "").trim()).filter(Boolean).join(" | ").slice(0, 300);
    });
  } catch { return ""; }
}

/** If we're on a landing page, try to reach the login form via a "Log in" link. */
async function gotoLoginForm(page, baseUrl, loginUrl, timeout) {
  await page.goto(loginUrl || baseUrl, { waitUntil: "domcontentloaded", timeout });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  let f = await tagLoginForm(page);
  if (f.pass || f.user) return f;
  const link = page.locator("a, button, [role=button]").filter({ hasText: /^\s*(log ?in|sign ?in|login|member login)\s*$/i }).first();
  if (await link.count()) {
    await link.click({ timeout: 5000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await sleep(500);
    f = await tagLoginForm(page);
  }
  return f;
}

/**
 * Perform a login. Returns { ok, message }.
 * Success = the password field disappears (or we leave the login URL) without an error message.
 */
async function login(page, { baseUrl, loginUrl, user, pass, timeout = 30000 }) {
  let f = await gotoLoginForm(page, baseUrl, loginUrl, timeout);
  if (!f.pass && !f.user) return { ok: false, message: "No login form found (no password/username field). Use --login-url to point at the login page." };
  const startUrl = page.url();
  if (f.user) await page.fill("[data-autoqa=user]", user);
  if (!f.pass) {
    // two-step login: submit username first
    if (f.submit) await page.click("[data-autoqa=submit]"); else await page.press("[data-autoqa=user]", "Enter");
    await page.waitForSelector("input[type=password]", { state: "visible", timeout: 10000 }).catch(() => {});
    f = await tagLoginForm(page);
    if (!f.pass) return { ok: false, message: "Username accepted but no password field appeared." };
  }
  await page.fill("[data-autoqa=pass]", pass);
  if (f.submit) await page.click("[data-autoqa=submit]", { timeout: 5000 }); else await page.press("[data-autoqa=pass]", "Enter");

  const deadline = Date.now() + Math.min(timeout, 20000);
  while (Date.now() < deadline) {
    await sleep(300);
    const stillPass = await hasPasswordField(page);
    if (!stillPass) {
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      if (!(await hasPasswordField(page))) return { ok: true, message: `Logged in; landed on ${page.url()}` };
    }
    if (page.url() !== startUrl && !stillPass) return { ok: true, message: `Logged in; landed on ${page.url()}` };
  }
  const err = await visibleErrorText(page);
  return { ok: false, message: `Still on login form after submit${err ? `: "${err}"` : ""}` };
}

/** Find & click a logout control (also opens likely user menus). */
async function logout(page) {
  const tryClick = async () => {
    const el = page.locator("a, button, [role=menuitem], [role=button]").filter({ hasText: LOGOUT_TEXT }).first();
    if ((await el.count()) && (await el.isVisible().catch(() => false))) { await el.click({ timeout: 5000 }); return true; }
    return false;
  };
  if (await tryClick()) return true;
  const menus = page.locator('[aria-haspopup], [data-toggle=dropdown], .avatar, .user-menu, [aria-label*="account" i], [aria-label*="profile" i], [aria-label*="user" i]');
  const n = Math.min(await menus.count(), 5);
  for (let i = 0; i < n; i++) {
    await menus.nth(i).click({ timeout: 3000 }).catch(() => {});
    await sleep(400);
    if (await tryClick()) return true;
    await page.keyboard.press("Escape").catch(() => {});
  }
  return false;
}

module.exports = { login, logout, hasPasswordField, looksLikeLoginForm, tagLoginForm, gotoLoginForm, visibleErrorText };
