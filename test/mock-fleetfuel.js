"use strict";
/**
 * A scripted stand-in for Claude, used to test the AI-tester pipeline end to end
 * (explore → plan → execute → guard rails → cleanup → report) without an API key.
 * It reads the same screen descriptions the real model gets and answers with the
 * same tool calls. Targets the FleetFuel demo app.
 *   node agent.js --url http://localhost:3000 --mock test/mock-fleetfuel.js --allow-destructive
 */
let idN = 0;
const toolUse = (name, input) => ({ content: [{ type: "tool_use", id: `toolu_mock_${++idN}`, name, input }], stop_reason: "tool_use", usage: {} });

function latestScreen(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    for (const b of m.content) if (b.type === "tool_result") return typeof b.content === "string" ? b.content : b.content.map((x) => x.text || "").join("\n");
  }
  return "";
}
const ref = (screen, kind, label) => { const m = screen.match(new RegExp(`\\[(e\\d+)\\] ${kind} "${label}`)); return m && m[1]; };
const rowRef = (screen, rowText, btn) => { const line = screen.split("\n").find((l) => /^\s+row \d+:/.test(l) && l.includes(rowText)); const m = line && line.match(new RegExp(`\\[(e\\d+)\\] ${btn}`)); return m && m[1]; };

const PLAN = {
  app: { name: "IoT Cube Fleet Fuel Intelligence", domain: "Fleet management", summary: "Fleet operators analyse fuel burned while vehicles idle, its cost and CO2, and manage vehicle types, users and settings.", userRole: "Super Admin — full access incl. users, data sources and settings" },
  modules: [
    { name: "Vehicle Types", purpose: "Maintain vehicle categories and their fuel-burn rates", screens: ["/vehicle-types"], records: ["Vehicle type: name, idle rate L/h, driving rate L/h"] },
    { name: "Reports", purpose: "Idling fuel, CO2 and cost reports", screens: ["/reports", "/reports/co2"], records: [] },
  ],
  journeys: [
    { name: "Maintain vehicle types", description: "Add a new vehicle type, correct its rates, retire it", modules: ["Vehicle Types"] },
    { name: "Review emissions", description: "Open the reports hub and drill into CO2", modules: ["Reports"] },
  ],
  testCases: [
    { id: "TC-001", category: "crud", module: "Vehicle Types", journey: "Maintain vehicle types", title: "Create, edit and delete a vehicle type", type: "create_edit_delete", priority: "P1", mutatesData: true, preconditions: "Logged in as admin", steps: ["Open Vehicle Types", "Enter '{TAG} Reefer Van' with idle 2.5", "Click 'Add type'", "Edit it: idle 3.1", "Delete it"], expectedResults: ["Row '{TAG} Reefer Van' appears", "Idle rate shows 3.1 L/h after edit", "Row is gone after delete"], testData: "{TAG} Reefer Van, idle 2.5 → 3.1, driving 10" },
    { id: "TC-002", category: "field_validation", module: "Vehicle Types", journey: "Maintain vehicle types", title: "Cannot add a vehicle type with an empty name", type: "validation", priority: "P2", mutatesData: false, preconditions: "", steps: ["Open Vehicle Types", "Leave name empty"], expectedResults: ["'Add type' is disabled"], testData: "empty" },
    { id: "TC-003", category: "crud", module: "Vehicle Types", journey: "Maintain vehicle types", title: "Safety rail: existing data cannot be deleted", type: "delete", priority: "P1", mutatesData: true, preconditions: "", steps: ["Open Vehicle Types", "Try to delete the existing 'Van' type"], expectedResults: ["The AI tester's guard refuses; 'Van' still exists"], testData: "existing row Van" },
    { id: "TC-004", category: "screens_buttons", module: "Reports", journey: "Review emissions", title: "Reports hub opens the CO2 report", type: "navigation", priority: "P2", mutatesData: false, preconditions: "", steps: ["Open /reports", "Click 'CO₂ Consumption'"], expectedResults: ["CO2 report with data rows is shown"], testData: "none" },
  ],
};

function create({ tag }) {
  return {
    usage: { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: () => 0,
    async create(params) {
      this.usage.requests++;
      const sys = String(params.system || "");
      if (/proofreader|localisation reviewer|UI\/UX reviewer/.test(sys)) {
        return { content: [{ type: "text", text: JSON.stringify({ issues: [] }) }], stop_reason: "end_turn", usage: {} };
      }
      if (params.output_config && params.output_config.format) {
        if (!/vehicle-types/.test(params.messages[0].content)) throw new Error("mock: app map did not include /vehicle-types");
        return { content: [{ type: "text", text: JSON.stringify(PLAN) }], stop_reason: "end_turn", usage: {} };
      }
      const first = params.messages[0].content;
      const tc = (first.match(/TEST CASE (\S+)/) || [])[1];
      const s = latestScreen(params.messages);
      const turn = params.messages.filter((m) => m.role === "assistant").length;
      const name = `${tag} Reefer Van`;
      const fin = (status, summary, extra = {}) => toolUse("finish", { status, summary, expected: extra.expected || "", actual: extra.actual || "", severity: status === "fail" ? "major" : "none", cleanedUp: true });

      if (tc === "TC-001") {
        if (!s.startsWith("SCREEN /vehicle-types") && !/SCREEN \/vehicle-types/.test(s)) return toolUse("navigate", { path: "/vehicle-types" });
        const row = s.split("\n").find((l) => /^\s+row/.test(l) && l.includes(name));
        if (turn < 12 && !row && !/value="3.1"/.test(s) && !this.created) {
          if (!s.includes(`value="${name}"`)) return toolUse("fill", { ref: ref(s, "text-input", "Type name"), text: name });
          if (!s.includes('"Idle rate (L/hour)" value="2.5"')) return toolUse("fill", { ref: ref(s, "number-input", "Idle rate"), text: "2.5" });
          this.created = true;
          return toolUse("click", { ref: ref(s, "button", "Add type") });
        }
        if (row && /2\.5 L\/h/.test(row) && !this.edited) {
          if (!s.includes(`Edit "${name}"`)) return toolUse("click", { ref: rowRef(s, name, "Edit") });
          if (!s.includes('"Idle rate (L/hour)" value="3.1"')) return toolUse("fill", { ref: ref(s, "number-input", "Idle rate"), text: "3.1" });
          this.edited = true;
          return toolUse("click", { ref: ref(s, "button", "Update type") });
        }
        if (row && /3\.1 L\/h/.test(row)) return toolUse("click", { ref: rowRef(s, name, "Delete") });
        if (!row && this.edited) return fin("pass", "Vehicle type was created, edited (idle 2.5 → 3.1) and deleted; list updated correctly each time.");
        return fin("fail", "Lifecycle did not behave as expected", { expected: "row with 3.1 L/h", actual: row || "row missing" });
      }
      if (tc === "TC-002") {
        if (!/SCREEN \/vehicle-types/.test(s)) return toolUse("navigate", { path: "/vehicle-types" });
        return /\[e\d+\] button "Add type" \(disabled\)/.test(s) ? fin("pass", "'Add type' stays disabled while the name is empty.") : fin("fail", "Empty name can be submitted", { expected: "button disabled", actual: "button enabled" });
      }
      if (tc === "TC-003") {
        if (!/SCREEN \/vehicle-types/.test(s)) return toolUse("navigate", { path: "/vehicle-types" });
        if (turn === 1) return toolUse("click", { ref: rowRef(s, "Van |", "Delete") });
        return /Refused/.test(s) && /row \d+: Van \|/.test(s) ? fin("pass", "The guard refused to delete existing business data; 'Van' is untouched.") : fin("fail", "Guard did not protect existing data", { expected: "refusal", actual: s.slice(0, 200) });
      }
      if (tc === "TC-004") {
        if (turn === 0) return toolUse("navigate", { path: "/reports" });
        if (/SCREEN \/reports\s/.test(s)) return toolUse("click", { ref: ref(s, "link", "[^\"]*CO₂ Consumption") });
        return /SCREEN \/reports\/co2/.test(s) && /table \(\d+ rows/.test(s) ? fin("pass", "CO2 report opened with data rows.") : fin("fail", "CO2 report missing", { expected: "CO2 table", actual: s.slice(0, 120) });
      }
      if (tc === "CLEANUP") {
        if (!/SCREEN \/vehicle-types/.test(s)) return toolUse("navigate", { path: "/vehicle-types" });
        const r = rowRef(s, tag, "Delete");
        if (r && turn < 8) return toolUse("click", { ref: r });
        return s.includes(tag) && /row/.test(s) ? fin("fail", "Tagged data remains") : fin("pass", `No records containing ${tag} remain.`);
      }
      return fin("blocked", "mock has no script for this test");
    },
  };
}
module.exports = { create };
