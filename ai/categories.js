"use strict";
/**
 * The six test categories of the test-case mapping, and the test cases that
 * are generated directly from the explored screens (one per screen), so that
 * "all screens" really means all screens — not whatever the AI chose to list.
 *
 * executor:
 *   "ai"          Claude runs the test case step by step in the browser (ai/executor.js)
 *   "screen"      every button / tab / dropdown / search box on one screen (ai/autochecks.js)
 *   "content"     spelling + text contrast on one screen
 *   "theme"       colour & font consistency across all screens
 *   "arabic"      Arabic switch + RTL layout + translation on one screen
 *   "responsive"  one screen at mobile / tablet / laptop / desktop sizes
 */

const CATEGORIES = [
  { key: "screens_buttons", code: "SCR", label: "1. Screens & buttons", description: "Every screen loads and every button, tab, dropdown and search works; business workflows" },
  { key: "content_theme", code: "TXT", label: "2. Spelling, content & colour theme", description: "Spelling and grammar of all text, readable contrast, consistent colours and fonts" },
  { key: "arabic", code: "AR", label: "3. Arabic", description: "Arabic language switch, right-to-left layout, untranslated or wrong text" },
  { key: "field_validation", code: "VAL", label: "4. Field validation", description: "Every field on every form rejects empty, invalid, too long and wrong-format input" },
  { key: "crud", code: "CRUD", label: "5. Add, edit & delete", description: "Full create → edit → delete lifecycle of every record type" },
  { key: "responsive", code: "RSP", label: "6. Responsive UI/UX", description: "Every screen on mobile, tablet, laptop and desktop sizes" },
];
const CATEGORY = Object.fromEntries(CATEGORIES.map((c) => [c.key, c]));

const VIEWPORTS = [
  { name: "Mobile", width: 375, height: 812 },
  { name: "Tablet", width: 768, height: 1024 },
  { name: "Laptop", width: 1366, height: 768 },
  { name: "Desktop", width: 1920, height: 1080 },
];

const pad = (n) => String(n).padStart(2, "0");

/** Test cases generated from the explored screens. */
function buildScreenCases(screens) {
  const out = [];
  const add = (category, executor, i, screen, title, steps, expected, extra = {}) => out.push({
    id: `${CATEGORY[category].code}-${pad(i)}`, category, executor, screen: screen ? screen.path : "", url: screen ? screen.url : "",
    module: screen ? screen.path : "All screens", journey: CATEGORY[category].label, title, type: category, priority: "P2",
    mutatesData: false, preconditions: "Logged in", steps, expectedResults: expected, testData: "none", enabled: true, ...extra,
  });
  screens.forEach((s, i) => add("screens_buttons", "screen", i + 1, s,
    `${s.path}: screen loads and every button, tab, dropdown and search works`,
    [`Open ${s.path}`, "Check the page loads without errors and shows content", "Click every safe button, tab and menu (delete/save/logout are skipped; data-changing requests are blocked)", "Try every option of every dropdown and type into every search box"],
    ["No JavaScript, console or server errors", "No error messages, blank areas, NaN/undefined values or broken images", "Every control responds without breaking the screen"], { priority: "P1" }));
  screens.forEach((s, i) => add("content_theme", "content", i + 1, s,
    `${s.path}: spelling, grammar and text readability`,
    [`Open ${s.path}`, "Proofread all visible text (headings, labels, buttons, messages, table headers)", "Measure the colour contrast of every text element against its background"],
    ["No spelling or grammar mistakes, consistent terminology and capitalisation", "All text meets WCAG AA contrast (4.5:1, or 3:1 for large text)"]));
  add("content_theme", "theme", screens.length + 1, null,
    "Colour theme and fonts are consistent across all screens",
    ["Collect the colours of headings, body text, links, buttons and backgrounds, and the fonts, on every screen", "Compare each screen with the rest of the application"],
    ["All screens use the same theme colours and fonts", "No screen uses off-theme colours for the same kind of element"]);
  add("arabic", "arabic", 1, null,
    "Arabic language can be selected",
    ["Look for a language switch (العربية / Arabic / AR) or an Arabic URL", "Switch the application to Arabic"],
    ["The interface switches to Arabic", "The page direction becomes right-to-left"], { arabicStep: "switch", priority: "P1" });
  screens.forEach((s, i) => add("arabic", "arabic", i + 2, s,
    `${s.path}: Arabic translation and right-to-left layout`,
    [`Open ${s.path} in Arabic`, "Check page direction, alignment and mirrored layout", "Find English text that was not translated", "Review the Arabic wording for mistakes"],
    ["Page is right-to-left (dir=rtl) and laid out correctly", "No untranslated English labels (except names, codes, units)", "Arabic text is correct and natural; numbers and dates are readable"]));
  screens.forEach((s, i) => add("responsive", "responsive", i + 1, s,
    `${s.path}: layout on mobile, tablet, laptop and desktop`,
    VIEWPORTS.map((v) => `View ${s.path} at ${v.name} size (${v.width}×${v.height})`).concat(["Review the mobile and tablet screenshots for UI/UX problems"]),
    ["No horizontal scrolling or content cut off", "No overlapping buttons, text or inputs", "Text is readable (≥ 12px) and buttons are big enough to tap on mobile", "Navigation stays usable on small screens"]));
  return out;
}

module.exports = { CATEGORIES, CATEGORY, VIEWPORTS, buildScreenCases };
