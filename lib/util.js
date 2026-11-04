"use strict";
/** Small shared helpers: CLI parsing, safety keyword lists, URL helpers. */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function slug(s) {
  return (s || "root").replace(/^https?:\/\/[^/]+/, "").replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "root";
}

/** Words that mean "this button changes or deletes data / ends the session". */
const DESTRUCTIVE = /\b(delete|remove|reset|clear all|destroy|drop|purge|deactivate|disable|archive|log ?out|sign ?out|save|submit|send|confirm|import|upload|pay|purchase|buy|checkout|approve|reject|yes|terminate|revoke|unsubscribe|cancel (subscription|order|account))\b/i;
const LOGOUT_TEXT = /\b(log ?out|sign ?out|logoff|log off)\b/i;
const SKIP_URL = /(log-?out|sign-?out|logoff|\/delete|\/remove|\/destroy|\/reset)/i;
const DOWNLOAD_EXT = /\.(pdf|zip|xlsx?|csv|docx?|pptx?|png|jpe?g|gif|svg|mp4|mp3|exe|dmg|gz|tar)(\?|$)/i;

function parseArgs(argv) {
  const opts = {
    url: process.env.QA_URL || "",
    logins: [],
    loginUrl: process.env.QA_LOGIN_URL || "",
    maxPages: 40,
    maxDepth: 5,
    maxClicks: 25,
    timeout: 30000,
    slowMs: 5000,
    out: "qa-report",
    headed: false,
    allowDestructive: false,
    scenarios: [],
    responsive: true,
    interactions: true,
    checkExternal: false,
    exclude: [],
    publicPaths: [],
    ignoreHttpsErrors: false,
    // AI tester options
    maxTests: 30,
    maxSteps: 40,
    planFile: "",
    planOnly: false,
    model: process.env.QA_AI_MODEL || "claude-opus-5-5",
    effort: process.env.QA_AI_EFFORT || "medium",
    only: [],
    mock: process.env.QA_AI_MOCK || "", // testing only: scripted stand-in for Claude
    instructions: "",
    arabicUrl: process.env.QA_ARABIC_URL || "",
  };
  let user = process.env.QA_USER || "";
  let pass = process.env.QA_PASS || "";
  const a = argv.slice();
  while (a.length) {
    const k = a.shift();
    const v = () => {
      if (!a.length) throw new Error(`Missing value for ${k}`);
      return a.shift();
    };
    switch (k) {
      case "--url": case "-u": opts.url = v(); break;
      case "--user": case "--username": user = v(); break;
      case "--pass": case "--password": pass = v(); break;
      case "--login": {
        const s = v(); const i = s.indexOf(":");
        if (i < 0) throw new Error("--login expects user:password");
        opts.logins.push({ user: s.slice(0, i), pass: s.slice(i + 1) });
        break;
      }
      case "--login-url": opts.loginUrl = v(); break;
      case "--max-pages": opts.maxPages = +v(); break;
      case "--max-depth": opts.maxDepth = +v(); break;
      case "--max-clicks": opts.maxClicks = +v(); break;
      case "--timeout": opts.timeout = +v(); break;
      case "--slow-ms": opts.slowMs = +v(); break;
      case "--out": case "-o": opts.out = v(); break;
      case "--headed": opts.headed = true; break;
      case "--allow-destructive": opts.allowDestructive = true; break;
      case "--scenarios": case "-s": opts.scenarios.push(v()); break;
      case "--no-responsive": opts.responsive = false; break;
      case "--no-interactions": opts.interactions = false; break;
      case "--check-external": opts.checkExternal = true; break;
      case "--exclude": opts.exclude.push(new RegExp(v(), "i")); break;
      case "--public": opts.publicPaths.push(new RegExp(v(), "i")); break;
      case "--insecure": opts.ignoreHttpsErrors = true; break;
      case "--max-tests": opts.maxTests = +v(); break;
      case "--max-steps": opts.maxSteps = +v(); break;
      case "--plan": opts.planFile = v(); break;
      case "--plan-only": opts.planOnly = true; break;
      case "--model": opts.model = v(); break;
      case "--effort": opts.effort = v(); break;
      case "--only": opts.only.push(...v().split(",").map((x) => x.trim()).filter(Boolean)); break;
      case "--instructions": opts.instructions = v(); break;
      case "--arabic-url": opts.arabicUrl = v(); break;
      case "--mock": opts.mock = v(); break;
      case "--help": case "-h": opts.help = true; break;
      default: throw new Error(`Unknown option: ${k} (use --help)`);
    }
  }
  // QA_LOGINS: extra accounts, one "user:password" per line (keeps secrets out of argv)
  for (const line of (process.env.QA_LOGINS || "").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) opts.logins.push({ user: line.slice(0, i).trim(), pass: line.slice(i + 1) });
  }
  if (user || pass) opts.logins.unshift({ user, pass });
  if (opts.url && !/^https?:\/\//i.test(opts.url)) opts.url = "https://" + opts.url;
  return opts;
}

/** Canonical form of a URL for de-duplication (keeps hash only for hash-routers). */
function normalizeUrl(href, base) {
  let u;
  try { u = new URL(href, base); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const keepHash = /^#!?\//.test(u.hash);
  if (!keepHash) u.hash = "";
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

function pathOf(url) {
  try { const u = new URL(url); return u.pathname + u.search + (/^#!?\//.test(u.hash) ? u.hash : ""); } catch { return url; }
}

module.exports = { sleep, slug, DESTRUCTIVE, LOGOUT_TEXT, SKIP_URL, DOWNLOAD_EXT, parseArgs, normalizeUrl, pathOf };
