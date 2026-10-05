# AGENTS.md — AmplifyX (x-post-checker)

Instructions for autonomous agents working in this repository. AmplifyX is a browser
extension for X (Twitter) that scores the viral potential of a draft while you type and
adds badges to eligible timeline posts. It ships for Chrome and Firefox, both Manifest
V3, built with [WXT](https://wxt.dev).

## Setup

- **Node.js 22+** and **pnpm 9** (the exact version is pinned in `packageManager`).
- Install once; the `postinstall` hook runs `wxt prepare` to generate `.wxt/` types:

```sh
pnpm install
```

- `.env.local` is gitignored and holds real X session cookies (`X_AUTH_TOKEN`, `X_CT0`)
  used only by the real-x.com smoke harness. Treat it as credential material: read it
  into memory in scripts, never log it, never commit it, never copy its contents into
  evidence or reports.

## Commands

| Task | Command |
| --- | --- |
| Typecheck (strict) | `pnpm typecheck` |
| Lint | `pnpm lint` |
| Unit tests (core logic) | `pnpm test:unit` |
| DOM tests (happy-dom) | `pnpm test:dom` |
| E2E tests (Playwright + fixture page) | `pnpm test:e2e` |
| All three suites in order | `pnpm test` |
| Dev build, Chrome (watch) | `pnpm dev` |
| Dev build, Firefox (watch) | `pnpm dev:firefox` |
| Release build, both browsers | `pnpm build` |
| Release build, one browser | `pnpm build:chrome` / `pnpm build:firefox` |
| E2E extension build | `pnpm build:test` |
| Package release zips | `pnpm package` |
| Package verification (loads zips in real browsers) | `pnpm verify:packages` |
| Cross-browser parity harness | `pnpm parity` (`parity:chrome`, `smoke:firefox`) |
| Real x.com read-only smoke | `pnpm test:real-x` |
| Standalone fixture server (port 3177) | `pnpm fixture` |

### Notes on the commands

- **Before declaring work done**, run at minimum `pnpm typecheck`, `pnpm lint`, and the
  narrowest affected test suite (`pnpm test:unit` or `pnpm test:dom`); `pnpm test` for
  broad changes.
- There is **no system browser** on dev/CI machines: `pnpm dev` never launches one. Load
  `.output/chrome-mv3-dev` manually in your own browser if you need to look at it.
- The E2E suite auto-starts the fixture server via its `webServer` config, runs with a
  single worker, and is serial on purpose (one persistent Chromium profile per test; keep
  it that way so profiles never contend).
- `pnpm test:real-x` runs against the **live, logged-in x.com**. It is intentionally
  separate from `pnpm test` — the anti-bot-prone live site must never gate a milestone.
  Never wire it into CI gates or test pipelines.
- `pnpm lint:firefox` builds the Firefox release output and runs `web-ext lint` with
  warnings as errors.

## The e2e build mode

`pnpm build:test` (mode `e2e`) adds exactly one behavior: the content script also injects
into the local fixture page, and a test-only protocol message can seed state and steer
the Jev endpoint to an in-process mock. **Release builds contain none of this** — test
hooks are inert unless the build mode is `e2e`. Never add a test hook outside a
`mode === 'e2e'` guard, and never let one leak into release behavior.

## Project-specific conventions

These rules are cited by comments throughout `src/` and `scripts/`; keep them intact and
follow them in new code.

- **Pointer discipline.** Page-overlaid hosts (overlay, badge, and popover panels) render with
  `pointer-events: none` so they can never block the page; only the extension's own
  buttons re-enable hit-testing. A click inside extension UI must never navigate or
  activate the post behind it. Tests assert this (`test/dom/badges.test.ts`), so a DOM
  change that flips pointer-events on a page-overlaid host panel is a bug, not a tweak.
  **Carve-out (Design 1b decision D2, user-approved 2026-10-05):** the draft overlay's
  IN-FLOW expanded block's own scroll area legitimately uses `pointer-events: auto`
  (`src/dom/overlay/overlay.ts`) so wheel/trackpad can scroll extension-owned content —
  that block occupies its own document-flow space (it pushes the toolbar down instead of
  covering the page), so it is not a page-overlaid surface and not a click-capture lane.
  The page-overlaid rule above stays intact and tested; do not weaken it.
- **One config module per concern; no magic numbers.** Every weight, coefficient,
  threshold, and tuning constant lives in the relevant `config.ts` (`src/core/heuristic-
  engine/config.ts`, `src/core/jev-client/config.ts`, `src/core/optimizer/config.ts`).
  Logic modules read them from config; do not inline numbers, and do not duplicate a
  constant in a second module.
- **Settings have a single writer.** All settings reads and writes go through the
  single-writer store in `src/core/`; do not read or write `browser.storage` ad hoc from
  a UI surface.
- **Real-x scripts are strictly read-only.** Anything touching the live x.com
  (`scripts/real-x-*.mjs`, the smoke harness) must never post, like, follow, repost,
  bookmark, or touch the Post button. Typing a synthetic draft into the composer without
  submitting is the most an automated run may do. A browser profile seeded with X
  session cookies is credential material: it is temporary, deleted when the run ends,
  and its contents are never persisted, logged, or exported.
- **Evidence redaction.** Screenshots and network captures from live-site runs land in
  `test-results/` (gitignored) and must stay redacted: no cookies, keys, headers, or
  personal timeline content. Method/host/path in network logs is the allowed maximum.
- **English-only UI.** All user-facing strings in `src/dom/` surfaces are English; there
  is no i18n layer.
- **Network calls.** The extension talks only to `api.typesafe.ai` (the Jev service) and
  only when a user key is configured. Local-only mode makes zero network calls. Do not
  add new hosts or telemetry.

## Layout

- `src/core/` — framework-free logic: settings single-writer store, message protocol,
  Jev client (retry/coalescing/caching), scorer, target analysis, optimizer.
- `src/dom/` — DOM surfaces (overlay, badges, popover, options, popup), Shadow-DOM based.
- `src/entrypoints/` — WXT entrypoints: background, content, options, popup.
- `scripts/` — packaging, manifest checks, ZIP validation, fixture server, outage proxy,
  parity harness, real-x probes.
- `test/` — `unit/` and `dom/` (Vitest, happy-dom) plus `e2e/` (Playwright) and fixtures.
- `docs/` — deep dives: timeline scanner, draft extraction, state ordering.

## Commit / PR discipline

- Branch from `main`; keep the diff scoped to the task.
- Never commit build output (`.output/`, `build/`), `test-results/`, `research/`, or
  `.env.local`; they are gitignored — keep it that way.
