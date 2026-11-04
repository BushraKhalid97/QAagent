#!/usr/bin/env node
"use strict";
/**
 * AutoQA web console.
 *
 *   AI tester:   URL + login → "Generate test cases" (explore + plan, nothing executed)
 *                → review page: approve / untick / edit / add test cases per category
 *                → "Run QA" executes only the approved cases → PASS/FAIL report
 *   Standard checks: URL + login → automatic checks → report
 *
 *   node server.js            → http://localhost:4545
 *   PORT=8080 HOST=0.0.0.0 node server.js   (expose on a network — protect it!)
 */
const http = require("http");
require("./lib/env"); // reads your private .env (API key etc.)
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PORT = +process.env.PORT || 4545;
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = path.resolve(process.env.QA_RUNS_DIR || path.join(process.cwd(), "qa-runs"));
fs.mkdirSync(ROOT, { recursive: true });
const runs = new Map();    // id -> public status (safe to send to the browser)
const secrets = new Map(); // id -> { user, pass } — memory only, never sent or written to disk
const UI = path.join(__dirname, "ui");

const MIME = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".xml": "application/xml", ".jpg": "image/jpeg", ".png": "image/png" };

/** The Claude key comes only from the server side (.env or environment) — never from the browser. */
const aiReady = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.QA_AI_MOCK);

function readBody(req) {
  return new Promise((res, rej) => {
    let b = ""; req.on("data", (c) => { b += c; if (b.length > 5e6) req.destroy(); });
    req.on("end", () => { try { res(JSON.parse(b || "{}")); } catch (e) { rej(e); } });
  });
}

const newId = () => new Date().toISOString().replace(/[:.]/g, "-");

/** Start a child process (agent.js or run.js) and track its output. */
function launch({ kind, script, args, env, meta }) {
  const id = newId();
  const dir = path.join(ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ kind, ...meta }, null, 2)); // no passwords in here
  const run = { id, kind, url: meta.url, user: meta.user || "", planId: meta.planId || null, started: Date.now(), log: "", done: false, code: null, summary: null, result: null, planCount: null };
  runs.set(id, run);
  const child = spawn(process.execPath, [path.join(__dirname, script), ...args, "--out", dir], { env });
  const onData = (d) => { run.log += d.toString(); if (run.log.length > 400000) run.log = run.log.slice(-300000); };
  child.stdout.on("data", onData); child.stderr.on("data", onData);
  child.on("close", (code) => {
    run.done = true; run.code = code;
    finish(run, dir);
  });
  return run;
}

function finish(run, dir) {
  try { const j = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8")); run.summary = j.summary; run.result = j.summary.result; } catch { run.result = null; }
  if (run.kind === "plan") {
    try { run.planCount = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8")).testCases.length; run.result = "READY"; } catch { run.result = "ERROR"; }
  }
}

function commonArgs(o) {
  const a = ["--url", String(o.url)];
  if (o.loginUrl) a.push("--login-url", String(o.loginUrl));
  if (o.destructive) a.push("--allow-destructive");
  if (o.insecure) a.push("--insecure");
  if (o.arabicUrl) a.push("--arabic-url", String(o.arabicUrl));
  return a;
}

/** Main form: AI → generate the test case mapping; checks → run standard checks. */
function startFromForm(body) {
  if (!body.url) throw new Error("Application URL is required");
  const meta = { url: String(body.url), user: body.user || "", loginUrl: body.loginUrl || "", destructive: !!body.destructive, insecure: !!body.insecure, arabicUrl: body.arabicUrl || "" };
  if (body.mode === "checks") {
    const args = [...commonArgs(meta), "--max-pages", String(+body.maxPages || 40), "--max-clicks", String(+body.maxClicks || 25)];
    let scenFile = null;
    if (body.scen && body.scen.trim()) { JSON.parse(body.scen); scenFile = path.join(ROOT, `scen-${newId()}.json`); fs.writeFileSync(scenFile, body.scen); args.push("--scenarios", scenFile); }
    const extras = String(body.extra || "").split(/\r?\n/).map((s) => s.trim()).filter((s) => s.includes(":"));
    return launch({ kind: "checks", script: "run.js", args, meta, env: { ...process.env, QA_USER: body.user || "", QA_PASS: body.pass || "", QA_LOGINS: extras.join("\n") } });
  }
  if (!aiReady()) throw new Error("The AI tester needs a Claude API key: add ANTHROPIC_API_KEY=... to the .env file in the project folder, then restart the console.");
  const args = [...commonArgs(meta), "--plan-only", "--max-pages", String(+body.maxPages || 30), "--max-tests", String(+body.maxTests || 40)];
  if (body.instructions) args.push("--instructions", String(body.instructions));
  const run = launch({ kind: "plan", script: "agent.js", args, meta, env: { ...process.env, QA_USER: body.user || "", QA_PASS: body.pass || "" } });
  secrets.set(run.id, { user: body.user || "", pass: body.pass || "" });
  return run;
}

function planPaths(id) {
  if (!/^[\w-]+$/.test(id)) throw new Error("bad id");
  const dir = path.join(ROOT, id);
  return { dir, plan: path.join(dir, "plan.json"), reviewed: path.join(dir, "reviewed-plan.json"), meta: path.join(dir, "meta.json") };
}

function getPlan(id) {
  const p = planPaths(id);
  if (!fs.existsSync(p.plan)) throw new Error("Test case mapping not found (still generating, or generation failed).");
  const plan = JSON.parse(fs.readFileSync(fs.existsSync(p.reviewed) ? p.reviewed : p.plan, "utf8"));
  const meta = JSON.parse(fs.readFileSync(p.meta, "utf8"));
  const sec = secrets.get(id);
  return { plan, meta, hasCreds: !!(sec && (sec.user || sec.pass)) || !meta.user, reviewed: fs.existsSync(p.reviewed) };
}

function savePlan(id, plan) {
  if (!plan || !Array.isArray(plan.testCases)) throw new Error("Invalid test plan");
  for (const t of plan.testCases) {
    if (!t.id || !t.title || !t.category) throw new Error(`Test case is missing id, title or category`);
    t.steps = (t.steps || []).map(String).filter((s) => s.trim());
    t.expectedResults = (t.expectedResults || []).map(String).filter((s) => s.trim());
  }
  fs.writeFileSync(planPaths(id).reviewed, JSON.stringify(plan, null, 2));
}

function runPlan(id, body) {
  if (!aiReady()) throw new Error("No Claude API key: add ANTHROPIC_API_KEY to .env and restart the console.");
  savePlan(id, body.plan);
  const { meta } = getPlan(id);
  const sec = secrets.get(id) || {};
  const user = body.user || sec.user || meta.user || "";
  const pass = body.pass || sec.pass || "";
  if (meta.user && !pass) throw new Error("Please enter the password again (the console was restarted since the test cases were generated).");
  const runMeta = { ...meta, destructive: !!body.destructive, planId: id, user };
  const args = [...commonArgs(runMeta), "--plan", planPaths(id).reviewed];
  const run = launch({ kind: "run", script: "agent.js", args, meta: runMeta, env: { ...process.env, QA_USER: user, QA_PASS: pass } });
  secrets.set(id, { user, pass });
  return run;
}

function loadHistory() {
  for (const id of fs.readdirSync(ROOT)) {
    const dir = path.join(ROOT, id);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      const meta = fs.existsSync(path.join(dir, "meta.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) : { kind: "checks" };
      const rep = fs.existsSync(path.join(dir, "report.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8")) : null;
      if (!rep) continue;
      const run = { id, kind: meta.kind || "checks", url: rep.meta.url, user: meta.user || "", planId: meta.planId || null, started: Date.parse(rep.meta.startedAt), log: "", done: true };
      finish(run, dir);
      runs.set(id, run);
    } catch { /* incomplete run */ }
  }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (code, body, type = "application/json") => { res.writeHead(code, { "content-type": type, "x-content-type-options": "nosniff", "cache-control": "no-store" }); res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
  try {
    if (u.pathname === "/" && req.method === "GET") return send(200, fs.readFileSync(path.join(UI, "console.html")), MIME[".html"]);
    let m;
    if ((m = u.pathname.match(/^\/review\/([\w-]+)$/))) return send(200, fs.readFileSync(path.join(UI, "review.html")), MIME[".html"]);
    if (u.pathname === "/api/config") return send(200, { aiReady: aiReady() }); // never exposes the key itself
    if (u.pathname === "/api/run" && req.method === "POST") return send(200, { id: startFromForm(await readBody(req)).id });
    if (u.pathname === "/api/runs") return send(200, [...runs.values()].sort((a, b) => b.started - a.started).map(({ log, ...r }) => r));
    if ((m = u.pathname.match(/^\/api\/runs\/([\w-]+)$/))) { const r = runs.get(m[1]); return r ? send(200, r) : send(404, { error: "not found" }); }
    if ((m = u.pathname.match(/^\/api\/plans\/([\w-]+)$/))) {
      if (req.method === "GET") return send(200, getPlan(m[1]));
      if (req.method === "POST") { savePlan(m[1], (await readBody(req)).plan); return send(200, { ok: true }); }
    }
    if ((m = u.pathname.match(/^\/api\/plans\/([\w-]+)\/run$/)) && req.method === "POST") return send(200, { id: runPlan(m[1], await readBody(req)).id });
    if ((m = u.pathname.match(/^\/runs\/([\w-]+)\/(.+)$/))) {
      const file = path.resolve(ROOT, m[1], decodeURIComponent(m[2]));
      if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || /meta\.json$/.test(file)) return send(404, "not found", "text/plain");
      return send(200, fs.readFileSync(file), MIME[path.extname(file)] || "application/octet-stream");
    }
    send(404, "not found", "text/plain");
  } catch (e) { send(400, { error: e.message }); }
});
loadHistory();
server.listen(PORT, HOST, () => console.log(`AutoQA console: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}  (runs saved in ${ROOT})`));
