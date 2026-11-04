"use strict";
/**
 * Turns the current screen into a compact text description an AI tester can
 * read and act on. Every interactive element gets a reference like [e12] that
 * the tester uses in click/fill/select actions. Table rows are listed with the
 * buttons that belong to them, so "the Delete button of row X" is unambiguous.
 */

async function snapshot(page, { maxChars = 9000, maxRows = 15 } = {}) {
  const data = await page.evaluate(({ maxRows }) => {
    const vis = (el) => {
      const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const clean = (t, n = 80) => (t || "").replace(/\s+/g, " ").trim().slice(0, n);
    const labelOf = (el) => {
      const aria = el.getAttribute("aria-label"); if (aria) return clean(aria);
      const lb = el.getAttribute("aria-labelledby");
      if (lb) { const t = lb.split(/\s+/).map((id) => (document.getElementById(id) || {}).innerText || "").join(" "); if (t.trim()) return clean(t); }
      if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return clean(l.innerText); }
      const wrap = el.closest("label");
      if (wrap) { const c = wrap.cloneNode(true); c.querySelectorAll("input,select,textarea,option").forEach((x) => x.remove()); if (clean(c.innerText)) return clean(c.innerText); }
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) {
        const prev = el.previousElementSibling; if (prev && /LABEL|SPAN|DIV|P/.test(prev.tagName) && clean(prev.innerText, 60)) return clean(prev.innerText, 60);
        return clean(el.placeholder || el.name || el.title || "");
      }
      const t = clean(el.innerText || el.value || "");
      if (!/[\p{L}\p{N}]/u.test(t)) return clean(el.title || (el.querySelector("img[alt]") || {}).alt || (el.querySelector("svg title") || {}).textContent || t); // icon-only button
      return t;
    };
    const kind = (el) => {
      const role = el.getAttribute("role"); if (role) return role;
      if (el.tagName === "A") return "link";
      if (el.tagName === "SELECT") return "dropdown";
      if (el.tagName === "TEXTAREA") return "textarea";
      if (el.tagName === "INPUT") return { checkbox: "checkbox", radio: "radio", submit: "button", button: "button", number: "number-input", email: "email-input", password: "password-input", date: "date-input", file: "file-input", search: "search-box", tel: "phone-input" }[el.type] || "text-input";
      if (el.isContentEditable) return "rich-text";
      return "button";
    };

    document.querySelectorAll("[data-qa-ref]").forEach((e) => e.removeAttribute("data-qa-ref"));
    const sel = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [role=radio], [role=option], [role=combobox], [role=textbox], [contenteditable=true], [onclick]';
    const dialogs = [...document.querySelectorAll('[role=dialog], [role=alertdialog], dialog[open], .modal.show, [aria-modal=true]')].filter(vis);
    const scope = dialogs.length ? dialogs[dialogs.length - 1] : document.body;
    let n = 0;
    const describe = (el) => {
      const ref = `e${++n}`;
      el.setAttribute("data-qa-ref", ref);
      const k = kind(el);
      let line = `[${ref}] ${k} "${labelOf(el)}"`;
      if (/input|textarea|search-box|rich-text/.test(k)) {
        const v = el.isContentEditable ? el.innerText : el.value;
        line += ` value="${clean(k === "password-input" ? (v ? "••••" : "") : v, 60)}"`;
        if (el.placeholder) line += ` placeholder="${clean(el.placeholder, 40)}"`;
      }
      if (k === "dropdown") {
        const opts = [...el.options].map((o) => clean(o.text, 30));
        line += ` selected="${clean((el.options[el.selectedIndex] || {}).text, 30)}" options=[${opts.slice(0, 12).join(" | ")}${opts.length > 12 ? ` …+${opts.length - 12}` : ""}]`;
      }
      if (k === "checkbox" || k === "radio" || k === "switch") line += el.checked || el.getAttribute("aria-checked") === "true" ? " (checked)" : " (unchecked)";
      if (k === "link" && el.getAttribute("href")) line += ` → ${clean(el.getAttribute("href"), 60)}`;
      if (el.required || el.getAttribute("aria-required") === "true") line += " (required)";
      if (el.disabled || el.getAttribute("aria-disabled") === "true") line += " (disabled)";
      if (el.validationMessage) line += ` (invalid: ${clean(el.validationMessage, 60)})`;
      return { ref, line };
    };

    // tables: rows with their own controls
    const tables = [];
    const inTable = new Set();
    for (const t of [...scope.querySelectorAll("table, [role=grid], [role=table]")].filter(vis).slice(0, 6)) {
      const headers = [...t.querySelectorAll("thead th, [role=columnheader]")].map((h) => clean(h.innerText, 30));
      const rows = [...t.querySelectorAll("tbody tr, [role=row]")].filter((r) => vis(r) && !r.querySelector("th, [role=columnheader]"));
      const lines = rows.slice(0, maxRows).map((r, i) => {
        const cells = [...r.querySelectorAll("td, [role=cell], [role=gridcell]")].map((c) => {
          const ctrls = [...c.querySelectorAll(sel)].filter(vis);
          ctrls.forEach((x) => inTable.add(x));
          const txt = clean(c.innerText, 40);
          if (!ctrls.length) return txt;
          return ctrls.map((x) => { const d = describe(x); return `[${d.ref}] ${clean(labelOf(x), 20) || kind(x)}`; }).join(" ") || txt;
        });
        return `  row ${i + 1}: ${cells.join(" | ")}`;
      });
      rows.slice(maxRows).forEach((r) => r.querySelectorAll(sel).forEach((x) => inTable.add(x)));
      tables.push(`table (${rows.length} rows${rows.length > maxRows ? `, first ${maxRows} shown` : ""}) columns: ${headers.join(" | ") || "(none)"}\n${lines.join("\n")}`);
    }

    const elements = [];
    for (const el of scope.querySelectorAll(sel)) {
      if (inTable.has(el) || !vis(el) || el.closest("[data-qa-ref]") && el.closest("[data-qa-ref]") !== el) continue;
      elements.push(describe(el).line);
      if (elements.length >= 160) { elements.push("… (more elements not shown)"); break; }
    }
    const messages = [...document.querySelectorAll('[role=alert], [role=status], [aria-live], .alert, .toast, .notification, .error, .success, .invalid-feedback, .text-danger, .snackbar')]
      .filter(vis).map((m) => `[${clean(m.className && typeof m.className === "string" ? m.className : m.getAttribute("role") || "message", 30)}] ${clean(m.innerText, 160)}`).filter((m) => !/\]\s*$/.test(m));
    const headings = [...scope.querySelectorAll("h1, h2, h3, legend, .card-title")].filter(vis).map((h) => clean(h.innerText, 60)).filter(Boolean).slice(0, 15);
    return {
      url: location.pathname + location.search + location.hash,
      title: document.title,
      dialog: dialogs.length ? clean(scope.innerText, 300) : "",
      headings, messages: [...new Set(messages)].slice(0, 8), tables, elements,
      text: clean(scope.innerText, 2500),
    };
  }, { maxRows });

  let out = `SCREEN ${data.url}  (title: ${data.title})\n`;
  if (data.dialog) out += `DIALOG OPEN (only its contents are listed): ${data.dialog}\n`;
  if (data.headings.length) out += `HEADINGS: ${data.headings.join(" | ")}\n`;
  if (data.messages.length) out += `MESSAGES ON SCREEN:\n${data.messages.map((m) => "  " + m).join("\n")}\n`;
  out += `CONTROLS:\n${data.elements.join("\n") || "(none)"}\n`;
  if (data.tables.length) out += `TABLES:\n${data.tables.join("\n")}\n`;
  out += `VISIBLE TEXT (excerpt): ${data.text}\n`;
  if (out.length > maxChars) out = out.slice(0, maxChars) + "\n… (screen description truncated)";
  return { text: out, url: data.url, title: data.title, dialogOpen: !!data.dialog };
}

module.exports = { snapshot };
