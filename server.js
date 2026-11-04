#!/usr/bin/env node
"use strict";
/**
 * AutoQA web console — a small local web page: paste a URL + login, press Run,
 * watch progress live, open the PASS/FAIL report. No extra dependencies.
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
const runs = new Map(); // id -> { id, url, started, log, done, code, summary }

const MIME = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".xml": "application/xml", ".jpg": "image/jpeg", ".png": "image/png" };

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AutoQA Console</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1d2330;--mute:#677086;--line:#e3e6ec;--acc:#0f766e;--pass:#127a3f;--fail:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#12151b;--card:#1b1f27;--ink:#e6e9ef;--mute:#9aa3b5;--line:#2c323d;--acc:#2dd4bf;--pass:#5fd394;--fail:#ff8a7e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif}main{max-width:980px;margin:0 auto;padding:24px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:16px}
label{display:block;font-size:13px;color:var(--mute);margin:10px 0 4px}input,select,textarea{width:100%;font:inherit;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0 14px}.chk{display:flex;gap:8px;align-items:center;margin-top:10px;color:var(--ink);font-size:14px}.chk input{width:auto}
button{font:inherit;font-weight:600;background:var(--acc);color:#fff;border:0;border-radius:8px;padding:10px 20px;margin-top:16px;cursor:pointer}button:disabled{opacity:.5}
pre{background:#0d1117;color:#c9d1d9;padding:12px;border-radius:8px;max-height:420px;overflow:auto;font-size:12px;white-space:pre-wrap}
.v{font-weight:800;font-size:20px}.PASS{color:var(--pass)}.FAIL{color:var(--fail)}a{color:var(--acc)}table{width:100%;border-collapse:collapse}td,th{padding:6px;border-bottom:1px solid var(--line);text-align:left;font-size:13px}
details summary{cursor:pointer;color:var(--mute);margin-top:12px}
</style></head><body><main>
<h1>AutoQA</h1><p style="color:var(--mute)">Enter the app's address and a login. The AI tester explores the app, works out its business flows, writes test cases and runs each one like a manual tester; Standard checks test every screen, button and form automatically. Both end with a PASS/FAIL report.</p>
<form class="card" id="f">
<fieldset style="border:0;padding:0;margin:0 0 6px"><legend style="font-size:13px;color:var(--mute);margin-bottom:6px">Testing mode</legend>
<label class="chk"><input type="radio" name="mode" value="ai" checked> <b>AI tester</b> — understands the business, writes and runs test cases like a manual tester (needs a Claude API key)</label>
<label class="chk"><input type="radio" name="mode" value="checks"> <b>Standard checks</b> — crawls every screen and runs automatic UI / error / security checks (no AI)</label></fieldset>
<label for="url">Application URL</label><input id="url" name="url" required placeholder="https://app.example.com">
<div class="grid"><div><label for="user">Username / email</label><input id="user" name="user" autocomplete="off"></div>
<div><label for="pass">Password</label><input id="pass" name="pass" type="password" autocomplete="new-password"></div></div>
<label for="extra">Extra accounts to test (one per line, user:password) — Standard checks only</label><textarea id="extra" name="extra" rows="2" placeholder="manager@example.com:Secret123"></textarea>
<div class="grid"><div><label for="apiKey">Claude API key (AI tester; leave empty if the server has ANTHROPIC_API_KEY)</label><input id="apiKey" name="apiKey" type="password" autocomplete="off" placeholder="sk-ant-..."></div>
<div><label for="maxTests">Max test cases (AI tester)</label><input id="maxTests" name="maxTests" type="number" value="30"></div></div>
<label for="instructions">Focus / instructions for the AI tester (optional)</label><input id="instructions" name="instructions" placeholder="e.g. focus on the order checkout and refund flows">
<label class="chk"><input type="checkbox" name="destructive"> <span><b>Allow creating, editing and deleting test data</b> — the AI tester only touches records it creates itself (tagged with a run id). Use a test environment.</span></label>
<details><summary>Advanced options</summary>
<div class="grid"><div><label for="maxPages">Max screens</label><input id="maxPages" name="maxPages" type="number" value="40"></div>
<div><label for="maxClicks">Max clicks per screen</label><input id="maxClicks" name="maxClicks" type="number" value="25"></div>
<div><label for="loginUrl">Login page URL (optional)</label><input id="loginUrl" name="loginUrl"></div></div>
<label for="scen">Custom use cases (JSON, optional — see scenarios/*.json)</label><textarea id="scen" name="scen" rows="4" placeholder='{"scenarios":[{"name":"...","steps":[{"goto":"/"},{"expectText":"Welcome"}]}]}'></textarea>
<label class="chk"><input type="checkbox" name="insecure"> Ignore HTTPS certificate errors</label>
</details>
<button id="go">Start testing</button></form>
<div class="card" id="out" hidden><div id="st"></div><pre id="log"></pre></div>
<div class="card"><h2 style="margin-top:0;font-size:16px">Previous runs</h2><table id="hist"></table></div>
</main><script>
const $=s=>document.querySelector(s);let timer;
async function hist(){const r=await (await fetch("/api/runs")).json();$("#hist").innerHTML="<tr><th>When</th><th>URL</th><th>Result</th><th></th></tr>"+r.map(x=>\`<tr><td>\${new Date(x.started).toLocaleString()}</td><td>\${x.url.replace(/</g,"&lt;")}</td><td class="\${x.result||""}">\${x.done?(x.result||"ERROR"):"running…"}</td><td>\${x.done?\`<a href="/runs/\${x.id}/report.html" target="_blank">report</a>\`:""}</td></tr>\`).join("")}
async function poll(id){const r=await (await fetch("/api/runs/"+id)).json();$("#log").textContent=r.log;$("#log").scrollTop=1e9;
$("#st").innerHTML=r.done?\`<span class="v \${r.result}">\${r.result||"ERROR"}</span> \${r.summary?\`— \${r.summary.total} tests · \${r.summary.pass} passed · \${r.summary.fail} failed · \${r.summary.warn} warnings\`:""} · <a href="/runs/\${id}/report.html" target="_blank">Open full report</a>\`:"Running… (this can take a few minutes)";
if(r.done){clearInterval(timer);$("#go").disabled=false;hist()}}
$("#f").onsubmit=async e=>{e.preventDefault();const fd=Object.fromEntries(new FormData(e.target));$("#go").disabled=true;$("#out").hidden=false;$("#log").textContent="";
const r=await fetch("/api/run",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(fd)});const j=await r.json();
if(!j.id){$("#st").textContent=j.error;$("#go").disabled=false;return}clearInterval(timer);timer=setInterval(()=>poll(j.id),1500)};hist();
</script></body></html>`;

function readBody(req) {
  return new Promise((res, rej) => {
    let b = ""; req.on("data", (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on("end", () => { try { res(JSON.parse(b || "{}")); } catch (e) { rej(e); } });
  });
}

function startRun(body) {
  if (!body.url) throw new Error("URL is required");
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  const ai = body.mode !== "checks";
  const args = ai
    ? [path.join(__dirname, "agent.js"), "--url", String(body.url), "--out", dir,
      "--max-pages", String(+body.maxPages || 30), "--max-tests", String(+body.maxTests || 30)]
    : [path.join(__dirname, "run.js"), "--url", String(body.url), "--out", dir,
      "--max-pages", String(+body.maxPages || 40), "--max-clicks", String(+body.maxClicks || 25)];
  if (ai && body.instructions) args.push("--instructions", String(body.instructions));
  if (ai && !body.apiKey && !process.env.ANTHROPIC_API_KEY && !process.env.QA_AI_MOCK) throw new Error("The AI tester needs a Claude API key (field above, or ANTHROPIC_API_KEY on the server).");
  if (body.loginUrl) args.push("--login-url", String(body.loginUrl));
  if (body.destructive) args.push("--allow-destructive");
  if (body.insecure) args.push("--insecure");
  if (!ai && body.scen && body.scen.trim()) {
    JSON.parse(body.scen); // validate
    const f = path.join(dir, "scenarios.json"); fs.writeFileSync(f, body.scen); args.push("--scenarios", f);
  }
  // credentials are passed via environment variables, never on the command line (visible in `ps`)
  const extras = String(body.extra || "").split(/\r?\n/).map((s) => s.trim()).filter((s) => s.includes(":"));
  const env = { ...process.env, QA_USER: body.user || "", QA_PASS: body.pass || "", QA_LOGINS: ai ? "" : extras.join("\n") };
  if (body.apiKey) env.ANTHROPIC_API_KEY = String(body.apiKey);
  const run = { id, url: body.url, started: Date.now(), log: "", done: false, code: null, summary: null, result: null };
  runs.set(id, run);
  const child = spawn(process.execPath, args, { env });
  const onData = (d) => { run.log += d.toString(); if (run.log.length > 400000) run.log = run.log.slice(-300000); };
  child.stdout.on("data", onData); child.stderr.on("data", onData);
  child.on("close", (code) => {
    run.done = true; run.code = code;
    try { const j = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8")); run.summary = j.summary; run.result = j.summary.result; } catch { run.result = null; }
  });
  return run;
}

function loadHistory() {
  for (const id of fs.readdirSync(ROOT)) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(ROOT, id, "report.json"), "utf8"));
      runs.set(id, { id, url: j.meta.url, started: Date.parse(j.meta.startedAt), log: "", done: true, summary: j.summary, result: j.summary.result });
    } catch { /* incomplete run */ }
  }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (code, body, type = "application/json") => { res.writeHead(code, { "content-type": type, "x-content-type-options": "nosniff" }); res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
  try {
    if (u.pathname === "/" && req.method === "GET") return send(200, PAGE, MIME[".html"]);
    if (u.pathname === "/api/run" && req.method === "POST") return send(200, { id: startRun(await readBody(req)).id });
    if (u.pathname === "/api/runs") return send(200, [...runs.values()].sort((a, b) => b.started - a.started).map(({ log, ...r }) => r));
    const m = u.pathname.match(/^\/api\/runs\/([\w-]+)$/);
    if (m) { const r = runs.get(m[1]); return r ? send(200, r) : send(404, { error: "not found" }); }
    const f = u.pathname.match(/^\/runs\/([\w-]+)\/(.+)$/);
    if (f) {
      const file = path.resolve(ROOT, f[1], decodeURIComponent(f[2]));
      if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file)) return send(404, "not found", "text/plain");
      return send(200, fs.readFileSync(file), MIME[path.extname(file)] || "application/octet-stream");
    }
    send(404, "not found", "text/plain");
  } catch (e) { send(400, { error: e.message }); }
});
loadHistory();
server.listen(PORT, HOST, () => console.log(`AutoQA console: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}  (runs saved in ${ROOT})`));
