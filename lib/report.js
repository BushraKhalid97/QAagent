"use strict";
/** Writes report.json, junit.xml (for CI) and a self-contained report.html. */
const fs = require("fs");
const path = require("path");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function writeJson(dir, data) {
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(data, null, 2));
}

function writeJunit(dir, data) {
  const bySuite = {};
  for (const t of data.tests) (bySuite[`${t.account ? t.account + " / " : ""}${t.suite}`] ||= []).push(t);
  let x = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="AutoQA" tests="${data.summary.total}" failures="${data.summary.fail}" skipped="${data.summary.skip}">\n`;
  for (const [s, ts] of Object.entries(bySuite)) {
    x += `  <testsuite name="${esc(s)}" tests="${ts.length}" failures="${ts.filter((t) => t.status === "fail").length}" skipped="${ts.filter((t) => t.status === "skip").length}">\n`;
    for (const t of ts) {
      x += `    <testcase classname="${esc(s)}" name="${esc(`${t.id} ${t.screen ? t.screen + " › " : ""}${t.name}`)}" time="${(t.durationMs / 1000).toFixed(3)}">`;
      if (t.status === "fail") x += `<failure message="${esc(t.message)}">${esc(t.evidence.join("\n"))}</failure>`;
      else if (t.status === "skip") x += `<skipped message="${esc(t.message)}"/>`;
      else if (t.status === "warn") x += `<system-out>${esc("WARNING: " + t.message + "\n" + t.evidence.join("\n"))}</system-out>`;
      x += `</testcase>\n`;
    }
    x += `  </testsuite>\n`;
  }
  fs.writeFileSync(path.join(dir, "junit.xml"), x + "</testsuites>\n");
}

function writeHtml(dir, data) {
  const s = data.summary;
  const screens = data.screens || [];
  const rows = data.tests.map((t) => `
    <tr class="row ${t.status}" data-status="${t.status}" data-suite="${esc(t.suite)}" data-text="${esc((t.screen + " " + t.name + " " + t.message + " " + t.account).toLowerCase())}">
      <td class="mono">${t.id}</td>
      <td><span class="badge ${t.status}">${t.status.toUpperCase()}</span></td>
      ${data.accounts.length > 1 ? `<td>${esc(t.account)}</td>` : ""}
      <td>${esc(t.suite)}</td>
      <td class="mono">${esc(t.screen)}</td>
      <td>${esc(t.name)}${t.message ? `<div class="msg">${esc(t.message)}</div>` : ""}
        ${t.evidence.length ? `<details><summary>${t.evidence.length} detail(s)</summary><ul>${t.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></details>` : ""}</td>
      <td>${t.screenshot ? `<a href="${esc(t.screenshot)}" target="_blank"><img loading="lazy" src="${esc(t.screenshot)}" alt="screenshot for ${esc(t.id)}"></a>` : ""}</td>
    </tr>`).join("");
  const suites = [...new Set(data.tests.map((t) => t.suite))];
  const suiteRows = suites.map((su) => {
    const ts = data.tests.filter((t) => t.suite === su);
    const c = (st) => ts.filter((t) => t.status === st).length;
    return `<tr><td>${esc(su)}</td><td>${ts.length}</td><td class="pass-t">${c("pass")}</td><td class="fail-t">${c("fail")}</td><td class="warn-t">${c("warn")}</td><td>${c("skip")}</td><td><span class="badge ${c("fail") ? "fail" : "pass"}">${c("fail") ? "FAIL" : "PASS"}</span></td></tr>`;
  }).join("");
  const screenRows = screens.map((sc) => {
    const ts = data.tests.filter((t) => t.screen === sc.path && t.account === sc.account);
    const f = ts.filter((t) => t.status === "fail").length, w = ts.filter((t) => t.status === "warn").length;
    return `<tr><td class="mono"><a href="${esc(sc.url)}" target="_blank" rel="noopener">${esc(sc.path)}</a></td>${data.accounts.length > 1 ? `<td>${esc(sc.account)}</td>` : ""}<td>${esc(sc.title)}</td><td>${ts.length}</td><td class="fail-t">${f}</td><td class="warn-t">${w}</td><td><span class="badge ${f ? "fail" : "pass"}">${f ? "FAIL" : "PASS"}</span></td><td>${sc.shot ? `<a href="${esc(sc.shot)}" target="_blank"><img loading="lazy" src="${esc(sc.shot)}" alt="screenshot of ${esc(sc.path)}"></a>` : ""}</td></tr>`;
  }).join("");

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QA Report – ${s.result}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1d2330;--mute:#677086;--line:#e3e6ec;--pass:#127a3f;--passbg:#e3f6ea;--fail:#b42318;--failbg:#fde7e5;--warn:#9a6700;--warnbg:#fff4d6;--skip:#55607a;--skipbg:#eef0f4}
@media (prefers-color-scheme:dark){:root{--bg:#12151b;--card:#1b1f27;--ink:#e6e9ef;--mute:#9aa3b5;--line:#2c323d;--passbg:#113321;--failbg:#3d1714;--warnbg:#3a2d0c;--skipbg:#262b35;--pass:#5fd394;--fail:#ff8a7e;--warn:#f2c14e;--skip:#aab3c5}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1280px;margin:0 auto;padding:24px 16px}
h1{margin:0 0 4px;font-size:22px}h2{font-size:16px;margin:28px 0 10px}.sub{color:var(--mute)}
.hero{display:flex;gap:16px;align-items:center;flex-wrap:wrap;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px}
.verdict{font-size:30px;font-weight:800;padding:10px 22px;border-radius:10px}.verdict.PASS{background:var(--passbg);color:var(--pass)}.verdict.FAIL{background:var(--failbg);color:var(--fail)}
.kpis{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 16px;min-width:110px}.kpi b{display:block;font-size:22px}
.pass-t{color:var(--pass)}.fail-t{color:var(--fail)}.warn-t{color:var(--warn)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;text-transform:uppercase;color:var(--mute);letter-spacing:.03em}
.wrap{overflow-x:auto}.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;word-break:break-all}
.badge{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px}.badge.pass{background:var(--passbg);color:var(--pass)}.badge.fail{background:var(--failbg);color:var(--fail)}.badge.warn{background:var(--warnbg);color:var(--warn)}.badge.skip{background:var(--skipbg);color:var(--skip)}
.msg{color:var(--mute);font-size:12px;margin-top:2px}details{margin-top:4px}summary{cursor:pointer;color:var(--mute);font-size:12px}details li{font-size:12px;word-break:break-word}
td img{width:120px;max-height:80px;object-fit:cover;object-position:top;border:1px solid var(--line);border-radius:6px}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}.filters button,.filters input,.filters select{font:inherit;padding:6px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer}.filters button.on{background:var(--ink);color:var(--bg)}.filters input{flex:1;min-width:160px;cursor:text}
</style></head><body><main>
<div class="hero"><div class="verdict ${s.result}">${s.result}</div><div><h1>Automated QA report</h1>
<div class="sub">${esc(data.meta.url)} · ${data.accounts.map(esc).join(", ") || "no login"} · ${esc(data.meta.startedAt)} · ${(data.meta.durationMs / 1000).toFixed(0)} s · ${screens.length} screen(s) · mode: ${data.meta.safeMode ? "safe (no data changed)" : "destructive allowed"}</div></div></div>
<div class="kpis"><div class="kpi">Total tests<b>${s.total}</b></div><div class="kpi">Passed<b class="pass-t">${s.pass}</b></div><div class="kpi">Failed<b class="fail-t">${s.fail}</b></div><div class="kpi">Warnings<b class="warn-t">${s.warn}</b></div><div class="kpi">Skipped<b>${s.skip}</b></div><div class="kpi">Pass rate<b>${s.total - s.skip ? Math.round((s.pass / (s.total - s.skip)) * 100) : 0}%</b></div></div>
<h2>By test suite</h2><div class="wrap"><table><tr><th>Suite</th><th>Tests</th><th>Pass</th><th>Fail</th><th>Warn</th><th>Skip</th><th>Status</th></tr>${suiteRows}</table></div>
<h2>Screens discovered</h2><div class="wrap"><table><tr><th>Screen</th>${data.accounts.length > 1 ? "<th>Account</th>" : ""}<th>Title</th><th>Tests</th><th>Fail</th><th>Warn</th><th>Status</th><th>Screenshot</th></tr>${screenRows || '<tr><td colspan="8">No screens</td></tr>'}</table></div>
<h2>All test cases</h2>
<div class="filters" role="group" aria-label="Filter by status"><button class="on" data-f="all">All</button><button data-f="fail">Failed</button><button data-f="warn">Warnings</button><button data-f="pass">Passed</button><button data-f="skip">Skipped</button>
<select id="suite" aria-label="Filter by suite"><option value="">All suites</option>${suites.map((x) => `<option>${esc(x)}</option>`).join("")}</select><input id="q" placeholder="Search tests…" aria-label="Search tests"></div>
<div class="wrap"><table id="tests"><tr><th>ID</th><th>Status</th>${data.accounts.length > 1 ? "<th>Account</th>" : ""}<th>Suite</th><th>Screen</th><th>Test case</th><th>Evidence</th></tr>${rows}</table></div>
</main><script>
let f="all";const q=document.getElementById("q"),su=document.getElementById("suite");
function apply(){const t=q.value.toLowerCase();document.querySelectorAll("tr.row").forEach(r=>{r.style.display=(f==="all"||r.dataset.status===f)&&(!su.value||r.dataset.suite===su.value)&&(!t||r.dataset.text.includes(t))?"":"none"})}
document.querySelectorAll("[data-f]").forEach(b=>b.onclick=()=>{f=b.dataset.f;document.querySelectorAll("[data-f]").forEach(x=>x.classList.toggle("on",x===b));apply()});q.oninput=apply;su.onchange=apply;
</script></body></html>`;
  fs.writeFileSync(path.join(dir, "report.html"), html);
}

function writeReports(dir, data) {
  writeJson(dir, data);
  writeJunit(dir, data);
  writeHtml(dir, data);
}

module.exports = { writeReports };
