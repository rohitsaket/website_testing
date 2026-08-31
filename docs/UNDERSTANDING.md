# Project understanding — `website_testing`

A file-by-file walkthrough of this repository, written after reading every source file.
It records how the pieces fit, which test depends on which markup attribute, what was
fixed during review, and what is still unverified.

---

## 1. What this project is

An **end-to-end (E2E) website testing harness**: a Playwright + TypeScript suite that drives a
real browser against a small website and asserts on user-visible behaviour.

The repo began as a single-line `README.md` (commit `5838347`). Everything below was built on
branch `arena/01a05969-website-testing` to turn the empty repo into a working, runnable suite.

The unusual design choice: **the website under test lives in this repo.** `demo-site/` is a real
(small) site and `server/server.mjs` serves it, so the suite is self-contained — no staging
environment, no internet, no fixture mocking needed to see tests pass.

## 2. How it runs

```
npm test
  └─ playwright test                       (playwright.config.ts)
       ├─ boots webServer ──────────────►  node server/server.mjs  ──►  serves demo-site/ on :4173
       │                                        (dependency-free static file server)
       ├─ for each of 4 projects: chromium / firefox / webkit / Mobile Chrome
       │    └─ for each spec in tests/*.spec.ts
       │         └─ Page Object (tests/pages/*.page.ts) resolves locators
       │              └─ real browser drives demo-site/, asserts on DOM
       └─ writes playwright-report/ + test-results/ (both gitignored)
```

Two independent verification paths exist:

| Path | Command | Needs a browser? | What it proves |
| --- | --- | --- | --- |
| E2E | `npm test` | Yes (download via `playwright install`) | Real user flows work in 4 engines |
| Smoke | `npm run smoke` | **No** | The server serves the right bytes, 404s, and MIME types |

The smoke path uses Node's built-in test runner (`node --test`) and exists because browser
binaries are not always downloadable (see §7).

## 3. File-by-file

### `playwright.config.ts` (50 lines) — the control centre

- `baseURL` = `process.env.BASE_URL` **or** `http://127.0.0.1:$PORT` (default port `4173`).
- `webServer` boots the demo site **only when `BASE_URL` is unset** — with an external target the
  block is `undefined`, so no local server is started.
- `retries: 2` / `workers: 2` / `forbidOnly` activate **only when `process.env.CI` is set**; locally
  you get zero retries and full parallelism so failures surface immediately.
- `timeout: 30_000` per test, `expect.timeout: 5_000` per assertion.
- `trace: 'on-first-retry'`, `screenshot: 'only-on-failure'`, `video: 'retain-on-failure'` → failures
  are debuggable without bloating passing runs.
- `testIdAttribute: 'data-testid'` — the contract that lets `getByTestId()` find elements that
  `app.js` creates dynamically.
- Reporters: `github` + `html` + `list` on CI; `html` + `list` locally, with `open: 'never'` so runs
  never try to launch a browser window.

### `server/server.mjs` (45 lines) — zero-dependency static server

- Resolves `ROOT` from `import.meta.dirname/../demo-site`, so it works from any cwd.
- Binds `0.0.0.0` by default (needed for container/preview access), port overridable via `PORT`.
- Request flow: decode URL → strip query → `normalize()` → strip leading `../` → `join(ROOT, rel)`
  → separator-aware containment check → read file, or 404 with an HTML body.
- **Traversal defence is two-layered:** `path.normalize()` absorbs leading `../` at the root, and
  the containment check rejects anything outside `ROOT` with `403`. Verified: `/../package.json`
  (sent raw, with `--path-as-is`) returns 404, not the real `package.json`.
- Sets `Cache-Control: no-store` so edits to `demo-site/` are picked up on reload.

### `demo-site/` — the system under test

| File | Role | Behaviours that tests depend on |
| --- | --- | --- |
| `index.html` | Home page | `<h1>Ship websites you trust</h1>`; `label[for=new-todo]` → "Add a task"; `#add-todo` button labelled **Add**; `#todo-empty` reads "No tasks yet."; `#increment` button; `<output id="count">` starts at `0` |
| `app.js` | Client logic | Todo items are `<li data-testid="todo-item">` each with `todo-toggle` / `todo-delete` buttons; completed items get CSS class `done`; empty input is ignored; state persisted to `localStorage` key `acme.todos`; **counter is deliberately not persisted** |
| `contact.html` | Contact page | `novalidate` form (so the app's own validation is what's tested); labels **Name / Email / Topic / Message**; error slots `#name-error`, `#email-error`, `#message-error`; status slot `#form-status` |
| `contact.js` | Form validation | Blank name/email → "… is required."; bad email → "Enter a valid email address."; message < 10 chars → length error; sets `aria-invalid="true"|"false"`; on success writes "Thanks! Your message has been sent." + `data-state="success"` and calls `form.reset()` |
| `about.html` | Navigation target | `<h1>About us</h1>`, a `<details>` disclosure, no script |
| `styles.css` | Styling | CSS custom properties; `.field-error`, `#form-status[data-state]`, `.todo-list li.done` |

Every page carries `<link rel="icon" href="data:," />` — this suppresses browser favicon requests,
which would otherwise 404 and can surface as console errors (see §6).

### `tests/pages/` — Page Objects

`home.page.ts` and `contact.page.ts` hold **every locator** plus navigation/`addTask`/`submitForm`
helpers. Tests never touch a selector directly. Locators are resolved in the constructor, so they
are lazy and re-evaluated on each use.

### `tests/*.spec.ts` — 12 specs (48 test cases across 4 projects)

| Spec | Test | Asserts |
| --- | --- | --- |
| `home.spec.ts` | renders hero + empty state | h1 text, "No tasks yet." visible, 0 items |
| | adds, completes, deletes a task | count 1 → class `done` → count 0, empty state returns |
| | ignores empty submissions | clicking Add on empty input adds nothing |
| | persists tasks across a reload | item survives `page.reload()` (proves `localStorage`) |
| | counter increments | `0 → 2` after two clicks |
| `contact.spec.ts` | validation errors when blank | all three messages + `data-state="error"` |
| | rejects malformed email | email-only error, name/message valid |
| | accepts a complete submission | success text, `data-state="success"`, fields cleared by `reset()` |
| | marks invalid inputs `aria-invalid` | a11y signal on name + email |
| `navigation.spec.ts` | moves between pages | URL, h1 per page, `aria-current="page"` on the active link |
| | serves a 404 | HTTP status 404 **and** a visible 404 heading |
| | titled, no console errors | all 3 pages match `/Acme Widgets/`; zero `console.error` |

### `scripts/smoke.test.mjs` — browser-free checks

Spawns the server on port `4399` in `before`, kills it in `after`, and asserts: home content,
about/contact 200, correct MIME types for CSS/JS, 404 for unknown paths, and that path traversal
cannot leak `package.json`. The traversal check has a second assertion
(`assert.doesNotMatch(body, /@playwright\/test/)`) so it would fail loudly if the containment
logic ever regressed, rather than passing on a bare 404.

### `ci/e2e-workflow.yml` + `package.json` + `tsconfig.json`

- CI: checkout → Node 22 (`cache: npm`) → `npm ci` → `playwright install --with-deps` → smoke →
  type check → `playwright test` → upload `playwright-report/` (7-day retention, `if: !cancelled()`).
- Scripts: `test`, `test:ui`, `test:headed`, `test:{chromium,firefox,webkit,mobile}`, `smoke`,
  `report`, `codegen`, `lint` (`tsc --noEmit`), `site` (serve the demo site manually).
- `tsconfig.json`: `strict`, ES2022, `noEmit`, `moduleResolution: bundler`, `types: ["node"]`.
- Dependencies: **three** devDependencies (`@playwright/test`, `@types/node`, `typescript`).

## 4. Coupling map — what breaks what

Each row is a contract between markup and test. Change the left column and the right column fails.

| Markup / JS | Consumed by |
| --- | --- |
| `label[for=new-todo]` text "Add a task" | `HomePage.todoInput` |
| Button text "Add" | `HomePage.addButton` |
| `data-testid` on todo item/toggle/delete (from `app.js`) | `HomePage.todoItems`, `completeTask`, `deleteTask` |
| Text "No tasks yet." | `HomePage.emptyMessage` |
| Button text "Increment", `#count` | `HomePage.counterButton/counterOutput` |
| `localStorage` key `acme.todos` | `home.spec.ts` persistence test |
| Labels Name / Email / Topic / Message | `ContactPage` fields |
| `#name-error` / `#email-error` / `#message-error` | `ContactPage.errorFor()` |
| `#form-status` text + `data-state` | all contact assertions |
| Link text Home / About / Contact + `aria-current` | `navigation.spec.ts` |
| `<title>` containing "Acme Widgets" | `toHaveTitle` |
| Server 404 body `<h1>404 …</h1>` | 404 test |

**Maintenance hazard:** `getByRole()` / `getByLabel()` match by *substring*, case-insensitively.
A future button named "Add all" would make `getByRole('button', { name: 'Add' })` resolve to two
elements and trip Playwright's strict-mode error. Pass `{ exact: true }` when adding similar
controls.

## 5. Environment gotcha

`reuseExistingServer: !process.env.CI` means that if a server is already listening on `4173`
(e.g. a long-running preview), `npm test` **attaches to that process** instead of starting a fresh
one. Convenient, but it also means stale server code can be served if `server.mjs` was edited
after the server started — restart it in that case.

## 6. Issues found during review, and fixes applied

| # | Issue | Evidence | Fix |
| --- | --- | --- | --- |
| 1 | Favicon 404s could surface as `console.error`, making the "no console errors" test flaky | `GET /favicon.ico → 404` | Added `<link rel="icon" href="data:," />` to all 3 pages |
| 2 | `webServer` booted the demo site even when `BASE_URL` pointed elsewhere, and `webServer.url` was set to the *external* URL (so Playwright would wait on a remote host) | config read | `webServer` is now `undefined` when `BASE_URL` is set; local URL used for the readiness probe |
| 3 | Containment check `filePath.startsWith(ROOT)` would also match a sibling directory like `demo-site-backup` | code read | Separator-aware check: `filePath === ROOT \|\| filePath.startsWith(ROOT + sep)` |
| 4 | `class="muted"` in `index.html` had **no CSS rule** (only a `--muted` variable existed) | `grep -n '\.muted' styles.css` → no match | Added `.muted { color: var(--muted); }` |
| 5 | `tsconfig.json` listed `server/**/*.mjs` in `include`, but without `allowJs` those files are silently ignored — the "type check" appeared to cover JS it never compiled | `tsc --listFiles` showed no `server/*.mjs` | Removed the misleading include |
| 6 | `const BASE` in `smoke.test.mjs` was unused | grep | Deleted |

Verified after the fixes: `npm run lint` clean · `npm run smoke` 5/5 ·
`npx playwright test --list` 48 tests · all demo-site routes 200/404 as expected · traversal
still blocked · `BASE_URL=… --list` works with no local server.

## 7. What is *not* verified

- **The full browser suite has never executed.** `cdn.playwright.dev` and the mirrors are
  unreachable from the sandbox that created this repo, so `npx playwright install` cannot complete
  and no Chromium/Firefox/WebKit binary exists here. Test *discovery*, types and every
  browser-independent check pass; the assertions themselves are unproven until someone runs
  `npx playwright install --with-deps && npm test` on a networked machine (CI does exactly this).
- Cross-engine behaviour (WebKit date/input handling, mobile-viewport layout) is therefore untested.
- The GitHub Actions workflow has never run — it lives at `ci/e2e-workflow.yml` and must be copied
  to `.github/workflows/e2e.yml` to activate, because the tooling used here is not permitted to
  write workflow files.

## 8. Natural next steps

- Accessibility: add `@axe-core/playwright` and scan each page.
- Visual regression: `expect(page).toHaveScreenshot()`.
- Replace the demo site with a real target: set `BASE_URL`, add auth-state reuse
  (`storageState`), and keep the demo site only as a fixture.
- API-level tests using Playwright's `request` fixture, alongside the UI specs.
- Split smoke tests into the CI matrix as a fast pre-flight gate (already ordered that way).
