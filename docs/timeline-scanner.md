# TimelineScanner spec — normative rules

How the timeline scanner turns live timeline DOM into `PostSnapshot`s and applies the rescoring
policy. Future reviews check conformance to THIS document instead of re-deriving the rules from
code; the wording below is the contract (VAL-TARGET-001..004, VAL-TARGET-025).

Implementations: `src/dom/timeline-scanner/extract.ts` (extraction),
`src/dom/timeline-scanner/scanner.ts` (scan loop + diff policy), `src/selectors.ts` (selector
registry), `src/core/post-snapshot.ts` (shape, pure parsers, change signature). Verified real-x
DOM facts: `library/x-dom.md`.

## 1. Scan loop: visibility, throttling, SPA

1. **Only VISIBLE articles are scanned.** A scan pass enumerates the current `article` matches
   (fresh query EVERY pass — no node references are ever cached across scans; the virtualized
   feed recycles nodes) and keeps those whose bounding box intersects the viewport with real
   area. Off-screen posts are never extracted until they become visible (VAL-TARGET-001).
2. **Throttle with a trailing pass.** Scan triggers (initial start, DOM mutations via
   MutationObserver, `scroll`, `resize`, `popstate`, `hashchange`) coalesce: one pass runs when
   the interval (250 ms default, `SCAN_THROTTLE_MS`) has elapsed since the last pass, otherwise a
   single trailing timer covers the burst (VAL-TARGET-004's burst behavior).
3. **Mutation lanes: childList + attributes + characterData over the page subtree.** x.com
   updates engagement counts IN PLACE inside an existing article (count text-node data and
   metric-button `aria-label` attributes) — a childList-only observer never sees those, and a
   changed metric would never be re-extracted. All lanes feed the SAME throttled pipeline; no
   direct scans, no node references cached (fresh queries every pass).
4. **Extension-owned mutations never schedule a pass.** A mutation record is "own" when its
   target lives inside an `amplifyx-*` host (marker incl. its per-pass diagnostics stamps,
   overlay, popover) or a per-article badge host, or when it ADDS an owned node (the
   host-append's target is the page's article). A batch schedules a pass only when some record
   is page-owned; without this filter every pass's own writes would re-trigger it forever.
   Removals are NEVER "own": a virtualized-feed recycling record bundles the page's new content
   with the old host's removal and MUST schedule the re-diff.
5. **SPA re-scan without reload.** Route changes re-render the primary column; the
   MutationObserver lane (plus the history-event lanes) schedules a pass, so every timeline type —
   For You, Following (an in-place tab swap), profile, search — is scanned after navigation with
   no page reload (VAL-TARGET-003).
6. **Lifecycle.** `start()`/`stop()` mirror the master switch. `stop()` disconnects the observer,
   removes listeners, cancels the pending timer, and removes EVERY mounted badge host — zero
   extension presence remains in the timeline. The diff state (id → metrics signature) survives a
   stop/start so unchanged posts are not rescored after a re-enable.

## 2. Rescoring policy (diff by post id + captured metrics)

Each pass, for every visible article, the scanner extracts the snapshot and compares
`postMetricsSignature(post)` (all captured metrics: text, author, verified, media, reply context,
in-network, age, counts, url) against the last signature stored for that id:

| Situation | Behavior |
|---|---|
| id unseen | dispatch scoring once with reason `'new'` |
| id seen, signature equal | NO event to the scoring sink, NO rescore; the per-pass `onScan` event still fires (reason `'unchanged'`) so badge rendering can re-sync idempotently |
| id seen, signature changed | dispatch scoring once with reason `'changed'` |
| recycled node (same `<article>` element, different post id) | the new id follows the same rules — `'new'` or `'changed'` — and the node's badge host is reused for the new post (never left attached to the prior post) |

- **Who actually scores: the badge controller, memoized.** The controller scores through an
  injectable `scoreTarget` memoized by post id + `postMetricsSignature(post)`: a cache hit
  (same id, same signature) reuses the stored `TargetScore`; a miss invokes the scorer EXACTLY
  once and stores the result. A hit is NOT unconditional reuse: the EXACT age gate (section 4)
  is re-evaluated from `publishedAt` against the CURRENT time on EVERY hit — the signature's
  rounded `ageMinutes` can stand still across the 48h boundary (48h±1s both round to 2880) — and
  a post now past the gate is excluded with the typed stale score at ZERO additional scorer
  invocations; still-eligible hits keep serving the cached score unchanged. Consequently
  `'unchanged'` events (which fire on every pass so rendering can re-sync) cost ZERO scoring
  invocations — threshold changes and recycled hosts repaint from the cached score, never by
  rescoring. The cache is bounded (oldest evicted beyond 2000 ids; an evicted id is scored once
  again, same documented cost as the diff state) and survives `stop()`/`start()` like the diff
  state, so a master-switch re-enable does not rescore. Conformance is asserted against ACTUAL
  scorer invocations (injected counting wrapper), never against the scanner's dispatch counter
  alone.
- At most ONE badge host per article: the host (`data-amplifyx-host="badge"`, created inert with
  `pointer-events: none`) is found before it is created; scans are idempotent (VAL-TARGET-004).
- The diff state is bounded: beyond `MAX_TRACKED_POSTS` (2000) ids, the oldest are evicted; a
  re-encountered evicted id is scored once again (bounded memory, documented cost).
- The extraction clock is injectable (`now` option); the throttle uses the real clock.

## 3. Field-for-field extraction (VAL-TARGET-025)

- **id + url — the article's OWN status link.** Primary: the permalink wrapping the article's
  `time[datetime]` (fixture and real x.com both wrap the timestamp in the status `<a>`).
  Fallback: a canonical `/<handle>/status/<id>` link OUTSIDE the tweet text, preferring one whose
  handle matches the name row's. The id is the trailing digits; `url` is the link resolved
  absolute. Reserved roots (`/i/status/…`, `/intent/…`) are never handles; an article without a
  resolvable status link (and thus without id/url/author) is SKIPPED, never guessed.
- **authorHandle.** The status link's handle segment (the canonical identity of the article's
  post). The name row (`User-Name`) anchors the fallback selection only.
- **text.** The `tweetText` block's text with `<br>` boundaries joined as newlines (multi-line
  posts keep their line structure).
- **verified.** Presence of `icon-verified` in the article.
- **hasMedia.** Presence of the registered media markers (`tweetPhoto` / `videoPlayer`) in the
  article.
- **isReply / replyToHandle.** A visible reply chip: a profile link whose visible text starts
  with `@` (the glyph is not localized) OUTSIDE the name row and the tweet text, with a handle
  different from the author's. Chip found → `isReply: true` + `replyToHandle`; otherwise
  `isReply: false` and the field is ABSENT — a mention inside the post text is not reply context,
  and nothing is guessed.
- **inNetwork.** True ONLY from a registered direction-verified viewer-follows-author marker.
  Real x.com exposes NO such marker in timeline articles (verified read-only inspection — the
  real Following feed had zero `socialContext`/`userFollowIndicator` nodes; `userFollowIndicator`
  means the REVERSE "Follows you", `socialContext` is generic context). On the real site the
  field therefore extracts FALSE (honest absence); the fixture renders a `viewerFollowsAuthor`
  marker to exercise the path. A future real marker is registered only with the same evidence
  standard.
- **publishedAt + ageMinutes.** From `time[datetime]`: `publishedAt` is the EXACT publication
  instant (epoch ms, unrounded); `ageMinutes` is that instant's whole-minute capture (rounded,
  clamped at 0 for future timestamps). An unparseable/missing timestamp skips the article. The
  hard eligibility gate consumes `publishedAt` ONLY — see the age rule below.
- **Engagement counts (DIGITS-ONLY).** The metric comes from the button's `data-testid`
  (`reply`/`retweet`/`like`/`bookmark`) — NEVER from label words. The VALUE comes from the digits:
  the visible count span (`app-text-transition-container`) preferred, else the aria-label's
  leading token. Separators are structural (separator + exactly three digits = thousands group;
  separator + one or two = decimal point), an optional compact-magnitude suffix rescales the
  digits ("1,2 mil" → 1200, "12K" → 12000, "1.234" → 1234, "310" → 310). Counts the article does
  not display (zero-count buttons) leave the field ABSENT. The same digits parse identically no
  matter which localized words surround them.

## 4. Age rule: the hard 48h eligibility gate (VAL-TARGET-010)

- **Eligibility is decided from the EXACT elapsed time** — `scoreTarget(post, now)` excludes a
  post iff `now - post.publishedAt > 48h` (strict; a post captured at exactly 48 hours is still
  eligible), mirroring the x-algorithm AgeFilter. The gate NEVER reads `ageMinutes`: its
  whole-minute rounding admits posts up to 30 seconds past the boundary (48h+1s rounds to 2880
  and would pass a `> 2880` gate). The scorer's clock is injectable; live scoring uses the
  scan-time clock.
- **Display rounding may stay — but never delays exclusion.** `ageMinutes` remains the captured
  age for the breakdown text ("eligible: 2h old"), for engagement-velocity math, and as the
  capture signature's age granularity; the signature flipping on a whole-minute tick still
  triggers a fresh rescore. Exclusion does NOT wait for that tick: on every score-cache hit the
  controller re-evaluates this exact gate from `publishedAt` against the current time (the
  rescoring policy, section 2), so a rescan just past 48h — where the rounded capture and the
  metrics signature stand still — drops the post from eligibility and clears its badge with zero
  additional scorer invocations. Snapshots without `publishedAt` (legacy captures) fall back
  to the whole-minute gate rather than guessing an instant.
