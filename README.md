# website_testing

End-to-end website testing suite built with [Playwright](https://playwright.dev) + TypeScript.

It ships with a small static **demo site** (`demo-site/`) and a dependency-free Node server
(`server/server.mjs`) so the suite runs out of the box with no external network access.
Point it at a real deployment by setting `BASE_URL` and dropping the `webServer` block.

## Layout

```
.
├── demo-site/            # system under test (static HTML/CSS/JS)
│   ├── index.html        # todo list (localStorage) + counter
│   ├── about.html
│   ├── contact.html      # form with client-side validation
│   └── app.js, contact.js, styles.css
├── server/server.mjs     # tiny static file server for the demo site (no deps)
├── tests/
│   ├── pages/            # Page Objects: one class per page, locators live here
│   │   ├── home.page.ts
│   │   └── contact.page.ts
│   ├── home.spec.ts      # todo CRUD, persistence, counter
│   ├── contact.spec.ts   # validation, success path, aria-invalid
│   └── navigation.spec.ts# routing, 404s, titles, console errors
├── scripts/smoke.test.mjs # browser-free HTTP checks (Node test runner)
├── playwright.config.ts  # browsers, reporters, tracing, webServer
└── .github/workflows/e2e.yml
```

## Getting started

```bash
npm install
npx playwright install --with-deps   # downloads Chromium, Firefox, WebKit
npm test                             # runs all 12 specs across 4 browser projects
```

Useful variants:

| Command | What it does |
| --- | --- |
| `npm run smoke` | Fast HTTP checks against the demo site — no browser needed |
| `npm run test:ui` | Opens Playwright's interactive UI mode |
| `npm run test:headed` | Runs with a visible browser window |
| `npm run test:chromium` | Single browser project |
| `npm run test:mobile` | Mobile Chrome (Pixel 7) emulation |
| `npm run report` | Opens the last HTML report |
| `npm run codegen` | Records clicks into test code |
| `npm run lint` | `tsc --noEmit` type check |

To browse the demo site manually: `npm run site` → http://localhost:4173

## Pointing it at a real website

```bash
BASE_URL=https://example.com npx playwright test --project=chromium
```

Then remove (or guard) the `webServer` block in `playwright.config.ts` — it's only needed to boot
the bundled demo site. `PLAYWRIGHT_` environment variables (e.g. `PLAYWRIGHT_BASE_URL`) and
`.env` files are also picked up if you prefer those.

## Conventions

- **Locators over selectors.** Tests use roles, labels and `data-testid`, never brittle CSS/XPath.
- **Page Objects.** Any selector that appears in more than one test belongs in `tests/pages/`.
- **Auto-waiting assertions.** `expect(...).toHaveText(...)` retries; no manual `waitForTimeout`.
- **Debuggable failures.** Trace + video + screenshot are retained on failure; the HTML report is
  uploaded as a CI artifact.

## Status

- ✅ `npm run lint` — TypeScript compiles clean.
- ✅ `npm run smoke` — 5/5 HTTP checks pass.
- ✅ `npx playwright test --list` — 48 tests discovered (12 specs × 4 projects).
- ⏳ **Full browser run not yet executed in this environment** — the Playwright browser CDNs
  (`cdn.playwright.dev` and mirrors) are unreachable from the sandbox that scaffolded the repo,
  so `npx playwright install` cannot complete. Run `npx playwright install --with-deps` on a
  machine with network access (or in GitHub Actions, where the workflow does it for you)
  to execute the suite.

## Next steps

- Add `@axe-core/playwright` for automated accessibility assertions.
- Add visual regression via `expect(page).toHaveScreenshot()`.
- Replace the demo site's `webServer` config with a real staging URL and add auth state reuse.
