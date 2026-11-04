"use strict";
/**
 * Phase 2 — UNDERSTAND & PLAN. Claude reads the app map and returns a
 * structured understanding of the business (modules, records, user journeys)
 * plus a prioritised list of manual-style test cases.
 */
const { textOf } = require("./llm");

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
        required: ["id", "module", "journey", "title", "type", "priority", "mutatesData", "preconditions", "steps", "expectedResults", "testData"],
        properties: {
          id: { type: "string", description: "TC-001, TC-002, …" },
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
2. Write the test cases a meticulous manual tester would execute against it.

Coverage to aim for, in priority order:
- P1: for every record type that can be created: a full lifecycle test — create it, confirm it appears in the list, open/edit it, confirm the change is shown, delete it, confirm it is gone. Core business workflows and cross-module effects (e.g. "a newly created item appears as an option in the report filter").
- P2: validation — required fields left empty, invalid formats (email, numbers, negative values, dates), duplicates, overly long text; each with the error the user should see or the action being prevented. Search, filters, sorting and pagination returning correct results. Reports/dashboards reflecting the data.
- P3: edge cases — special characters and unicode in text fields, boundary values, cancelling a form leaves data unchanged, browser back/refresh keeps the app consistent.

Rules for every test case:
- Base it ONLY on screens, controls and fields that are present in the app map; refer to them by their visible labels. Never invent features.
- Each test case must be self-contained: it creates whatever data it needs and deletes that data at the end. Never depend on another test case having run.
- Every record a test creates must have a name/title/text value containing the literal placeholder {TAG} (it will be replaced with a unique run id), e.g. "{TAG} Refrigerated Van". Use realistic values for other fields.
- A test may only edit or delete records it created itself (whose name contains {TAG}); never existing business data.
- Do not include logging out, changing your own password, deleting or disabling your own user account, or bulk "reset/clear all data" actions.
- Steps are concrete user actions ("Click 'Add type'", "Enter '{TAG} Van' in 'Type name'"). Expected results are observable on screen ("A success message is shown", "The table contains a row '{TAG} Van' with idle rate 2.5 L/h").
- Mark mutatesData=true for any test that creates, edits or deletes.
- Stay within the requested maximum number of test cases; when you must choose, prefer P1, then breadth across modules.`;

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
  return planJson;
}

module.exports = { plan, PLAN_SCHEMA };
