# AutoQA — an AI tester for any web app

Give AutoQA a **URL** and a **login**. It tests your application the way an
experienced manual tester would, then hands you a **PASS / FAIL QA report**.
You don't need to write test scripts or documentation.

AutoQA has two tools:

| | **AI Tester** (`agent.js`) | **Standard checks** (`run.js`) |
| --- | --- | --- |
| What it does | Understands the business, writes test cases, and runs each one step by step like a manual tester | Crawls every screen and runs automatic checks on every page, button and form |
| Finds | Broken business flows: data not saved, wrong values, failed edits/deletes, missing validation, broken cross-module flows | Crashes, JS/API errors, broken data, layout/accessibility issues, security gaps |
| Needs | A Claude API key | Nothing extra |

Both work on any web app (React, Angular, Vue, Next.js, server-rendered…).

---

## AI Tester: how it works

```
URL + login
   │
   ▼
1. EXPLORE     visits every screen; opens every "Add / New / Edit / Connect…" form
   │           (nothing is saved while exploring)
   ▼
2. UNDERSTAND  Claude works out the business domain, its modules, the records each
   │           module manages (with their fields) and the user journeys, including
   │           journeys that cross modules
   ▼
3. PLAN        Claude writes test cases like a QA lead:
   │             P1  full lifecycle of every record: create → verify → edit → verify → delete → verify gone
   │                 core workflows and cross-module effects
   │             P2  validation (empty/invalid/duplicate input), search, filter, sort, paging, reports
   │             P3  edge cases (special characters, boundaries, cancel, back/refresh)
   ▼
4. EXECUTE     Claude runs every test case in a real browser, one action at a time.
   │           It reads the screen after each action, adapts to the real UI, and
   │           decides PASS / FAIL / BLOCKED with expected vs actual and a severity
   ▼
5. CLEAN UP    deletes every record the run created
   ▼
QA REPORT      what the AI understood · journeys · every test case with its executed
               steps, expected vs actual, severity and screenshot · JSON + JUnit for CI
```

### Run it

1. Install (once):
   ```bash
   git clone https://github.com/BushraKhalid97/qaagent.git
   ```
   ```bash
   cd qaagent && npm install && npx playwright install chromium
   ```
2. Save your Claude API key once (get one at https://console.anthropic.com → API Keys):
   ```bash
   cp .env.example .env
   ```
   Open `.env` and paste your key after `ANTHROPIC_API_KEY=`. Every run reads it
   automatically from then on. `.env` is private: Git ignores it, so it is never
   uploaded to GitHub. **Never put the key in the code itself.** This repository is
   public, and a key committed here can be used by anyone and is usually revoked
   automatically within minutes.

3. Start the web console:
   ```bash
   node server.js
   ```
   Open http://localhost:4545. Choose **AI tester**, enter URL, username and
   password, and tick **Allow creating, editing and deleting test data** if this
   is a test environment.

   Or use the command line:
   ```bash
   QA_USER=me@company.com QA_PASS=secret node agent.js --url https://test.myapp.com --allow-destructive
   ```

### Using the key on servers and in CI

Don't commit `.env`. Store the key in the platform's secret settings, which
pass it to the app as the `ANTHROPIC_API_KEY` environment variable:

| Where it runs | Where to put the key |
| --- | --- |
| Your computer | `.env` file (above) |
| GitHub Actions | Repo → Settings → Secrets and variables → Actions → `ANTHROPIC_API_KEY`; use `${{ secrets.ANTHROPIC_API_KEY }}` |
| Vercel | Project → Settings → Environment Variables → `ANTHROPIC_API_KEY` |
| Docker / a server | `docker run -e ANTHROPIC_API_KEY=...`, or the server's environment settings |

Any other solution of yours that calls Claude through the official Anthropic SDK
reads `ANTHROPIC_API_KEY` the same way, so one key in the right secret store
covers all of them.

### Safe by design

Testing creates, edits and deletes data, so the AI tester has safety rails
**enforced in code**. They don't rely on the AI behaving:

- **SAFE mode (default):** nothing is saved or deleted. Only read-only journeys
  run; data-changing test cases are listed as skipped.
- **FULL mode** (`--allow-destructive`): every record the tester creates has a
  unique **run tag** in its name (e.g. `QA2A9F1 Refrigerated Van`). The tester
  can **only edit or delete records that carry this tag**. If it tries to change
  or delete existing business data, the click is refused and the attempt is
  logged.
- It never logs out, and it never confirms an "Are you sure?" popup unless that
  popup follows an approved action on its own test data.
- A network guard blocks data-changing requests (POST/PUT/PATCH/DELETE) that
  don't carry the run tag and don't directly follow an approved action.
- At the end, a cleanup pass removes everything with the run tag.

Still, **run FULL mode against a test or staging environment**, not production.

### Useful options

```
--allow-destructive        FULL mode (create / edit / delete tagged test data)
--max-tests 30             how many test cases to write and run
--instructions "..."       focus the tester, e.g. "concentrate on the invoice approval flow"
--plan-only                explore + write the test plan (plan.json) without executing it
--plan plan.json           run a saved (and optionally hand-edited) plan again: repeatable regression
--only TC-003,TC-007       run selected test cases
--max-steps 40             browser actions allowed per test case
--model claude-opus-5-5    Claude model; --effort low|medium|high for execution depth
--headed                   watch the browser while it tests
```

A good routine is to run `--plan-only` once, review or edit `qa-report/plan.json`,
then run `--plan plan.json` on every release.

### Cost

Each run makes one planning request, plus roughly one request per browser action.
A run of about 30 test cases usually takes a few hundred requests. The exact token
use and estimated cost are printed at the end and shown in the report. To save
money, use `--plan-only` and then rerun a saved plan, use `--only` to rerun just
the failures, or lower `--effort`.

### Limits

- **Logins with CAPTCHA or SMS/MFA codes** can't be automated. Use a test account
  without them.
- **One account per run.** To test another role, run again with that account.
- **File uploads, emails, payments** and anything else outside the browser can't
  be completed. Those test cases end as BLOCKED, with the reason.
- The AI judges results from what it sees on screen. **Review FAIL verdicts**
  before filing bugs. Each one includes the exact steps, expected vs actual, and
  a screenshot.

---

# Standard checks (no AI)

The rest of this README covers `run.js`, the automatic checks that need no API
key.


## Setup (once)

```bash
git clone https://github.com/BushraKhalid97/qaagent.git
cd qaagent
npm install
npx playwright install chromium
```

## Run the standard checks

### Option A: the web console (easiest)

```bash
node server.js
```

Open **http://localhost:4545**, enter the URL, username and password, and press
**Run QA**. You can watch progress live, then open the report. Past runs are
saved in `qa-runs/`.

### Option B: command line / CI

```bash
QA_USER="me@company.com" QA_PASS="secret" node run.js --url https://app.company.com
```

(`--user` / `--pass` also work, but env vars keep the password out of your
shell history.)

The console prints the result and every failed test case. The exit code is
`0` = PASS, `1` = FAIL, `2` = could not run, so it can gate a CI pipeline.
`qa-report/junit.xml` plugs into GitHub Actions, Jenkins, GitLab and Azure DevOps.

### Testing several roles

```bash
node run.js --url https://app.company.com \
  --login 'admin@company.com:Pass1' \
  --login 'viewer@company.com:Pass2'
```

Each account gets its own crawl, so the report shows which screens each role can
reach. You can also put extra accounts in the env var `QA_LOGINS`, one
`user:password` per line.

---

## What gets tested (automatically)

| Suite | Test cases | Fails when… |
| --- | --- | --- |
| **Smoke** | Site reachable, response time | 5xx / unreachable |
| **Authentication** | Login form found · empty login rejected · wrong password rejected (with a message) · valid login works · session survives navigation · logout ends the session | any of these is broken |
| **Coverage** | Crawls every link **and** every click that navigates, up to `--max-pages` | nothing could be discovered |
| **Screen** (each screen) | HTTP status · load time · no JS errors / console errors / failed API calls · not blank · no "error" text on screen · no `NaN` / `undefined` / `[object Object]` in data · images load · page title | a defect is found |
| **Interactions** (each screen) | Clicks every button, tab, menu, toggle, sortable header; opens & closes dialogs; tries every option of every dropdown/filter; types normal, empty, HTML and SQL-like input into search boxes | a click/selection throws, errors, crashes the screen or logs the user out |
| **Forms** | Required fields enforced · email/url fields reject bad input (checked via the browser, **never submitted**) | required fields can be bypassed |
| **Responsive** | Mobile 375 px and tablet 768 px layouts, with screenshots | *(warning)* horizontal overflow |
| **Accessibility** | Labels, alt text, button names, `lang`, headings, duplicate ids | *(warning)* |
| **Access control** | Every screen and every API call seen while logged in is retried **without** login | a screen or API serves data without authentication |
| **Security** | HTTPS · security headers · session-cookie flags | plain HTTP (headers & cookies are warnings) |
| **Links** | File/download links, and external links with `--check-external` | broken link |
| **Use cases** | Your own business scenarios (see below) | a step fails |

**FAIL** means a real defect. **WARN** means a quality issue worth fixing that
doesn't fail the run. **SKIP** means something was deliberately not tested.

### Safe by default

AutoQA is meant to be safe to point at a live system:

- Buttons that look destructive (Delete, Remove, Reset, Save, Submit,
  Import, Pay, Log out…) are **not clicked**. The report lists each one it
  skipped.
- Every `POST / PUT / PATCH / DELETE` fired while exploring is **blocked**, so
  no data can change.
- Native "Are you sure?" dialogs are always **dismissed**.
- Forms are validated through the browser and never submitted.

To exercise create/update/delete flows too, use a **test environment** with
`--allow-destructive`.

---

## Your own use cases (no code)

Write business test cases as JSON and pass them with `--scenarios file.json`.
In the web console, paste the JSON into "Custom use cases".

```json
{
  "scenarios": [
    {
      "name": "Manager can open the CO2 report",
      "accounts": ["manager@company.com"],
      "allowHttp": [403],
      "steps": [
        { "goto": "/reports" },
        { "click": "CO₂ Consumption" },
        { "expectUrl": "/reports/co2" },
        { "select": "select[name=type]", "value": "Van" },
        { "fill": "input[type=search]", "value": "TRK-01" },
        { "press": "Enter" },
        { "expectText": "CO₂" },
        { "expectNoText": "Error" },
        { "expectVisible": "table" },
        { "expectNotVisible": "a[href='/admin']" },
        { "expectCount": "table tbody tr", "min": 1 },
        { "screenshot": "co2-filtered" }
      ]
    }
  ]
}
```

`click` and `fill` accept either visible text (`"Save"`) or a CSS selector
(`"button.primary"`). `accounts` limits a scenario to specific logins, which is
how you test role permissions. `allowHttp` lists HTTP errors that are expected
in that scenario, such as a 403 on a denied page.

For a working example, see [`scenarios/fleetfuel.json`](scenarios/fleetfuel.json),
which covers navigation, reports, and role-based access for the FleetFuel app.

---

## All options (standard checks)

```
--url <URL>             App to test (or env QA_URL)
--user / --pass         Login (or env QA_USER / QA_PASS)
--login user:pass       Extra account (repeatable, or env QA_LOGINS)
--login-url <url>       Login page, if not reachable from the start URL
--scenarios <file>      Custom use cases (repeatable)
--max-pages <n>         Screens per account (default 40)
--max-depth <n>         Link depth (default 5)
--max-clicks <n>        Controls clicked per screen (default 25)
--slow-ms <ms>          Slow-page threshold (default 5000)
--exclude <regex>       Skip matching URLs
--public <regex>        URLs that are public on purpose (skip access-control test)
--allow-destructive     Click everything and allow writes (test env only)
--no-interactions       Only load & check screens
--no-responsive         Skip mobile/tablet checks
--check-external        Check external links
--insecure              Accept self-signed HTTPS certificates
--headed                Watch the browser work
--out <dir>             Report folder (default qa-report)
```

## Output

```
qa-report/
  report.html   ← open this: verdict, per-suite & per-screen status, every test case, screenshots
  report.json   ← machine-readable results
  junit.xml     ← for CI dashboards
  shots/        ← screenshots (desktop, mobile, tablet, failures)
```

## Limits (standard checks)

- **CAPTCHA, SMS codes and other MFA** can't be automated. Use a test account
  without MFA, or point `--login-url` at a test-only login.
- **Login detection** handles standard username/password forms, including
  two-step ones (username → Next → password). Single sign-on redirects (Google,
  Azure AD, Okta) work if those pages use normal fields.
- **Business rules** (for example, "the total must equal the sum of rows")
  can't be guessed. Express them as **use cases**.
- **Canvas-only apps** (games, maps) get the page-level checks but limited
  interaction coverage.
