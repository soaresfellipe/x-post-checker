# AmplifyX

AmplifyX is a browser extension for X (Twitter) that tells you how viral a post could be — while
you type it, and across your timeline. It works in Chrome and Firefox (both Manifest V3).

## What it does

- **Draft score while you write.** On any X compose surface (main composer or reply), AmplifyX
  analyzes your draft as you type and shows a 0–100 viral-potential headline, the local signals
  behind it (length, hashtags, links, media, question, and more), and one weakness to fix.
- **AI judgment on top — with your own key.** If a Jev API key is configured, the extension asks
  the Jev AI service for a second opinion and blends it into the score, a confidence figure, the
  detected weaknesses, and a plain-language verdict.
- **Timeline hints.** Eligible posts on your home timeline get a small badge with the main reason
  they spread (engagement velocity, recency, …). Clicking a badge opens a popover with the full
  local/AI breakdown for that post. Posts older than 48 hours are deliberately excluded.
- **Draft optimizer.** For qualifying drafts, the optimizer offers structural rewrites (hook
  variants), hashtag suggestions with rationale, and an over-length warning with exact counts.
  Copying a suggestion puts exactly that text on your clipboard — your composer is never modified.
- **Failure honesty.** If the AI service is unreachable or fails, the local score stays usable and
  the UI says so explicitly ("AI judgment unavailable — local signals still apply"). Nothing jams.

## Privacy

**Bring your own key; nothing of yours goes anywhere you didn't configure.**

- Your Jev API key is stored only in your browser's local extension storage and is sent **only** to
  `api.typesafe.ai`, attached to the analysis requests you trigger.
- What is sent to the Jev service: the **draft text you are analyzing** (or the text of a timeline
  post you explicitly open the popover for) plus the analysis rubric version. No cookies, no
  browsing history, no identity, no telemetry.
- Without a key, everything still works in local-only mode: no network calls are made at all
  beyond the page itself.
- The extension requests access only to `x.com` / `twitter.com` content-script injection and to
  `api.typesafe.ai` for the Jev requests. It reads no other sites and ships no analytics.
- Clearing the key in the Options page deletes it from storage immediately.

## Install (unpacked, from source)

You need Node.js 22+ and pnpm 9. Then:

```sh
pnpm install
pnpm build:chrome   # -> .output/chrome-mv3
pnpm build:firefox  # -> .output/firefox-mv3
```

### Chrome

1. Run `pnpm build:chrome`.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `.output/chrome-mv3` directory.
5. Open the extension's **Options** page (Details → Extension options) to connect your Jev key,
   or click the toolbar icon for the popup status view.

### Firefox

1. Run `pnpm build:firefox`.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on** and pick `manifest.json` inside `.output/firefox-mv3`.
4. The temporary install lasts for this Firefox session; the Options page (in the extension's
   listing under Manage) connects your Jev key.

> Firefox gates content-script injection behind the site permissions listed in the manifest, so
> both `x.com`/`twitter.com` appear under the extension's Permissions. If the overlay does not
> appear, check the extension's permissions tab and make sure site access is granted.

## Build and package

| Command | What it produces |
| --- | --- |
| `pnpm build` | Both browsers' unpacked builds (`.output/chrome-mv3`, `.output/firefox-mv3`). |
| `pnpm build:chrome` / `pnpm build:firefox` | One browser's unpacked build. |
| `pnpm package` | Both **release zips**: `build/amplifyx-chrome-mv3.zip` and `build/amplifyx-firefox-mv3.zip`. Each archive is validated (non-empty, readable ZIP, contains `manifest.json`) before it lands in `build/`. |
| `pnpm verify:packages` | Re-validates the zips from `build/`, checks both release manifests, **loads the Chrome zip in a real browser** (service worker + Options page) and **installs the Firefox zip in headless Firefox** (temporary install + web-ext lint on the shipped bytes). Screenshots land in `build/verify/`. |
| `pnpm lint:firefox` | Builds the Firefox release build and runs `web-ext lint` with warnings as errors. |

## Tests

| Command | What it runs |
| --- | --- |
| `pnpm typecheck` | TypeScript, strict. |
| `pnpm lint` | ESLint. |
| `pnpm test:unit` | Vitest unit suite (core logic, protocol, transports, scorer, optimizer). |
| `pnpm test:dom` | DOM suite (happy-dom): overlay, badges, popover, options, popup behavior. |
| `pnpm test:e2e` | Playwright E2E against the fixture page (loads the real e2e extension build; see below). |
| `pnpm test` | All three suites in order. |
| `pnpm parity` | **Cross-browser fixture parity**: the same 12 scenario flows (composer detection, empty state, local score, Jev success/failure/clearing/stale responses, SPA teardown/remount, API-outage resilience on both surfaces) run in Chrome (Playwright) and Firefox (web-ext + headless Firefox), their outcomes are compared field-by-field, and each browser's Options page is opened and verified. |
| `pnpm parity:chrome` / `pnpm smoke:firefox` | The same harness for one browser. |
| `pnpm fixture` | Standalone fixture server (port 3177) — the harnesses host it in-process themselves. |

### The e2e build mode

`pnpm build:test` builds the extension with `--mode e2e`. That build adds exactly one behavior:
its content script also injects into the local fixture page, and the smoke harness can seed test
state and steer the Jev endpoint to an in-process mock through a test-only protocol message. The
**release** build (`mode production`) contains none of this — test hooks are inert unless the
build mode is `e2e`.

## Repository layout

- `src/core/` — settings single-writer store, message protocol, Jev client (retry/coalescing/caching), scorer, target analysis, optimizer.
- `src/dom/` — overlay, badges, popover, options and popup surfaces (English-only UI).
- `src/entrypoints/` — WXT entrypoints: background (event page/service worker), content, options, popup.
- `scripts/` — packaging, manifest checks, ZIP validation, fixture server, outage proxy, parity harness.
- `test/` — `unit/`, `dom/`, `e2e/`, plus fixtures.
- `docs/` — deep dives (timeline scanner, timeline of decisions).

## License

Private project; all rights reserved.
