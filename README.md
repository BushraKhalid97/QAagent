# AutoQA — one-command QA for any web app

Give AutoQA a **URL** and **login credentials**. It finds every screen, runs the
test cases below, and gives you a **PASS / FAIL** result plus a detailed HTML
report with screenshots. You don't need to write any test scripts.

It works on any web app (React, Angular, Vue, Next.js, server-rendered…), not
just FleetFuel.

---

## 1. Setup (once)

```bash
git clone https://github.com/BushraKhalid97/QAagent.git && cd QAagent
npm install
npx playwright install chromium
```

## 2. Run it

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

## 3. What gets tested (automatically)

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

## 4. Your own use cases (no code)

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

## 5. All options

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

## 6. Output

```
qa-report/
  report.html   ← open this: verdict, per-suite & per-screen status, every test case, screenshots
  report.json   ← machine-readable results
  junit.xml     ← for CI dashboards
  shots/        ← screenshots (desktop, mobile, tablet, failures)
```

## 7. Limits

- **CAPTCHA, SMS codes and other MFA** can't be automated. Use a test account
  without MFA, or point `--login-url` at a test-only login.
- **Login detection** handles standard username/password forms, including
  two-step ones (username → Next → password). Single sign-on redirects (Google,
  Azure AD, Okta) work if those pages use normal fields.
- **Business rules** (for example, "the total must equal the sum of rows")
  can't be guessed. Express them as **use cases**.
- **Canvas-only apps** (games, maps) get the page-level checks but limited
  interaction coverage.
