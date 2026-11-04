"use strict";
/**
 * Loads settings (e.g. ANTHROPIC_API_KEY) from a private `.env` file next to
 * this project, so you only have to enter your key once per machine.
 * `.env` is listed in .gitignore and is never committed. Values already set in
 * the environment take precedence over the file.
 */
const fs = require("fs");
const path = require("path");

function loadEnv() {
  for (const file of [path.join(__dirname, "..", ".env"), path.join(process.cwd(), ".env")]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
}

loadEnv();
module.exports = { loadEnv };
