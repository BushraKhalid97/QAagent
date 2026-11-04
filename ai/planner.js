"use strict";
/**
 * Phase 2 — UNDERSTAND & PLAN. Claude reads the app map and returns a
 * structured understanding of the business (modules, records, user journeys)
 * plus a prioritised list of manual-style test cases.
 */
const { textOf } = require("./llm");
const { CATEGORIES, CATEGORY, buildScreenCases } = require("./categories");

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["app", "modules", "journeys", "testCases"],
  properties: {
    app: {
      type: "object", additionalProperties: false, required: ["name", "domain", "summary", "userRole"],
      properties: {
        name: { type: "string" },
        domain: { type: "string", description: "Business domain, e.g. fleet management, e-commerce, HR" },
        summary: { type: "string", description: "2-4 sentences: what the business uses this app for" },
        userRole: { type: "string", description: "What the logged-in account can do, inferred from visible menus/actions" },
      },
    },
    modules: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["name", "purpose", "screens", "records"],
        properties: {
          name: { type: "string" },
          purpose: { type: "string" },
          screens: { type: "array", items: { type: "string" } },
          records: { type: "array", items: { type: "string" }, description: "Business records managed here (e.g. 'Vehicle type: name, idle rate, driving rate')" },
        },
      },
    },
    journeys: {
      type: "array",
      description: "End-to-end business flows a real user performs",
      items: {
        type: "object", additionalProperties: false, required: ["name", "description", "modules"],
        properties: { name: { type: "string" }, description: { type: "string" }, modules: { type: "array", items: { type: "string" } } },
      },
    },
    testCases: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["id", "category", "module", "journey", "title", "type", "priority", "mutatesData", "preconditions", "steps", "expectedResults", "testData"],
        properties: {
          id: { type: "string", description: "TC-001, TC-002, …" },
          category: { type: "string", enum: ["screens_buttons", "field_validation", "crud"], description: "screens_buttons = business workflows, navigation, search/filter/sort, reports; field_validation = input validation of form fields; crud = add / edit / delete lifecycles" },
          module: { type: "string" },
          journey: { type: "string" },
          title: { type: "string" },
          type: { type: "string", enum: ["create_edit_delete", "create", "edit", "delete", "workflow", "validation", "search_filter_sort", "navigation", "reporting", "permission", "edge_case"] },
          priority: { type: "string", enum: ["P1", "P2", "P3"] },
          mutatesData: { type: "boolean", description: "true if the test creates, edits or deletes anything" },
          preconditions: { type: "string" },
          steps: { type: "array", items: { type: "string" } },
          expectedResults: { type: "array", items: { type: "string" } },
          testData: { type: "string" },
        },
      },
    },
  },
};

const SYSTEM = `You are a senior QA lead. You have been handed a web application you have never seen, with no documentation. A crawler has explored it for you while logged in, and produced an "app map": a text description of every screen it reached (headings, controls, tables, messages) and of the forms that open when "Add / New / Edit…" style buttons are clicked.

Your job:
1. Work out what business this application serves, what its modules are, which business records each module manages (with their fields), and the end-to-end journeys real users perform — including journeys that cross modules (e.g. a record created in one module appearing in another module's lists, filters or reports).
   In "modules", list EVERY functional area of the app (usually one per main menu entry or screen group, e.g. Dashboard, Reports, Users, Settings), each with its screens and records — not just the first one. Every test case's "module" must be one of these module names.
2. Write the test cases a meticulous manual tester would execute against it.

Other parts of the system already generate, per screen: page-load and click-every-button checks, spelling and colour-theme checks, Arabic/RTL checks and responsive-layout checks. YOUR test cases cover three categories:

category "crud" — Add, edit & delete (P1): for EVERY record type that can be created anywhere in the app, one full lifecycle test: create it, confirm it appears in the list, open/edit it, confirm the change is shown, delete it, confirm it is gone. Also add/edit/delete inside other records (e.g. line items) if present.

category "field_validation" — Field validation (P2): cover EVERY input field on EVERY form in the app map. Group the fields of one form into one test case per form (or per tab of a large form). For each field test what applies: required field left empty; invalid format (email, phone, URL, date, number); negative / zero / out-of-range numbers; text too long (e.g. 300 characters); leading/trailing spaces; special characters and Arabic/unicode text accepted where text is allowed; duplicates where names must be unique. State the expected behaviour: error message shown next to the field, or the save button disabled, or the value rejected — and that nothing invalid is saved. If valid data must be saved to complete the test, use {TAG} and delete it afterwards.

category "screens_buttons" — Screens & business workflows (P1–P3): end-to-end business journeys, including cross-module effects (e.g. "a newly created item appears as an option in the report filter"); search, filters, sorting and pagination returning correct results; reports and dashboards reflecting the data; links and drill-downs going to the right place; cancelling a form leaves data unchanged; browser back/refresh keeps the app consistent.

Rules for every test case:
- Base it ONLY on screens, controls and fields that are present in the app map; refer to them by their visible labels. Never invent features.
- Each test case must be self-contained: it creates whatever data it needs and deletes that data at the end. Never depend on another test case having run.
- Every record a test creates must have a name/title/text value containing the literal placeholder {TAG} (it will be replaced with a unique run id), e.g. "{TAG} Refrigerated Van". Use realistic values for other fields.
- A test may only edit or delete records it created itself (whose name contains {TAG}); never existing business data.
- Do not include logging out, changing your own password, deleting or disabling your own user account, or bulk "reset/clear all data" actions.
- Steps are concrete user actions ("Click 'Add type'", "Enter '{TAG} Van' in 'Type name'"). Expected results are observable on screen ("A success message is shown", "The table contains a row '{TAG} Van' with idle rate 2.5 L/h").
- Mark mutatesData=true for any test that creates, edits or deletes.
- Stay within the requested maximum number of test cases. Make sure every record type has a crud test and every form has a field_validation test before adding more screens_buttons workflows.`;

async function plan(llm, { appMap, mapText, maxTests, account, allowMutation, extraInstructions }) {
  const user = `APP MAP (${appMap.screens.length} screens, explored as ${account || "anonymous user"}):
${mapText}

Write the test plan now. Maximum ${maxTests} test cases.${allowMutation ? "" : "\nNOTE: this run is in SAFE mode — data must not be changed. Only write test cases with mutatesData=false (navigation, search/filter/sort, reports, validation that is blocked before saving)."}${extraInstructions ? `\nAdditional instructions from the tester: ${extraInstructions}` : ""}`;
  const msg = await llm.create({
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
    max_tokens: 64000,
    effort: "high",
    output_config: { format: { type: "json_schema", schema: PLAN_SCHEMA } },
  });
  if (msg.stop_reason === "max_tokens") throw new Error("Test plan was cut off (too long). Lower --max-tests.");
  const planJson = JSON.parse(textOf(msg));
  planJson.testCases = planJson.testCases.slice(0, maxTests);
  planJson.testCases.forEach((tc) => { tc.executor = "ai"; tc.enabled = true; if (!CATEGORY[tc.category]) tc.category = "screens_buttons"; });
  // per-screen test cases (all screens × categories 1, 2, 3, 6), then sort into category order
  planJson.screens = appMap.screens.map((s) => ({ path: s.path, url: s.url, title: s.title }));
  const order = Object.fromEntries(CATEGORIES.map((c, i) => [c.key, i]));
  planJson.testCases = [...buildScreenCases(appMap.screens), ...planJson.testCases]
    .sort((a, b) => order[a.category] - order[b.category]);
  // safety net: every module referenced by a test case appears in the module list
  const known = new Set(planJson.modules.map((m) => m.name));
  for (const tc of planJson.testCases.filter((t) => t.executor === "ai")) {
    if (!known.has(tc.module)) {
      known.add(tc.module);
      planJson.modules.push({ name: tc.module, purpose: "(referenced by test cases)", screens: [], records: [] });
    }
  }
  return planJson;
}

module.exports = { plan, PLAN_SCHEMA };
