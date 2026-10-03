# DraftSnapshot extraction spec — normative rules

How the composer watcher turns live composer DOM into a `DraftSnapshot`. Future reviews check
conformance to THIS document instead of re-deriving the rules from code or fixtures; the wording
below is the contract for the four rule families that scrutiny rounds 1–2 converged.

Implementations: `src/dom/composer-watcher/extract.ts` (extraction), `src/selectors.ts`
(selector registry), `src/core/draft-snapshot.ts` (shape, parsers, eligibility gate).
Verified real-x DOM facts: `library/x-dom.md` (the 2026-10-03 follow-state inspection).

## 1. Raw character counting (charCount, text)

`charCount` is the RAW length of `text` — no X-style URL/CJK weighting. The eligibility gate
(`isDraftEligible`, VAL-SETUP-014) compares this raw count against `minDraftLength`; the
boundary is exact: N−1 raw chars stays below, N raw chars qualifies.

`text` is built from the composer's DIRECT children, mirroring DraftEditor's one-block-per-line
model:

1. **Line blocks** (direct `div`/`p` children) are joined with `\n`. A block's content is its
   `textContent` (nested inline markup included, tags ignored).
2. **Empty line blocks are REAL lines.** A `<div><br></div>` block contributes the newline that
   separates it from what precedes it — user-entered leading blank lines, interior blank lines,
   and trailing blank lines ALL count toward `charCount`. A draft of Enter + 9 characters is 10
   raw characters and must be analyzed at `minDraftLength = 10` (VAL-SETUP-014, VAL-DRAFT-030).
3. **The untouched placeholder is the single exception:** one empty line block with nothing
   before it contributes no characters (`text === ''`, `charCount === 0`), so the empty state
   (VAL-DRAFT-005) survives. As soon as ANY content precedes a block — another block (even a
   blank one), a non-blank text node, or a non-blank inline element — that block joins with its
   newline. Leading blank lines are user content, never placeholder shape.
4. **Whitespace-only top-level text nodes are markup formatting**, not draft content (DraftEditor
   keeps all text inside line blocks); they are skipped. Non-blank inline elements append
   verbatim with no line break of their own.

Examples (normative):

| Composer children | text | charCount |
|---|---|---|
| `<div><br></div>` | `''` | 0 (untouched placeholder) |
| `<div>123456789</div>` | `123456789` | 9 |
| `<div><br></div><div>123456789</div>` | `\n123456789` | 10 |
| `<div>123456789</div><div><br></div>` | `123456789\n` | 10 |
| `<div>one</div><div><br></div><div>two</div>` | `one\n\ntwo` | 8 |
| `<div><br></div><div><br></div><div>real text</div>` | `\n\nreal text` | 11 |

## 2. Composer recognition (including the structural fallback)

Candidates come only from the registered `composer` chain in `src/selectors.ts`:

1. **Primary testid levels** (`tweetTextarea_0` home, `tweetTextarea_1+` reply dialog) are
   trusted on their own testid. The status-page reply composer is ALSO `tweetTextarea_0`
   (observed 2026-10-03) — a numbered testid alone does not tell home from reply; the visible
   reply context does (see §3).
2. **Structural fallback** (`public-DraftEditor-content` textbox) matches ONLY when the editor
   sits inside a recognized composer container (`*RichTextInputContainer` or `toolBar`). An
   unrelated DraftEditor on a composer-less route (e.g. an Explore search box) attracts no
   watcher, no overlay, and no analysis (VAL-DRAFT-029).
3. **Priority** when several match: numbered reply composers (`_1+`) > home (`_0`) > structural
   fallback; DOM order breaks ties. At most ONE composer is watched; detection failure is silent
   (`null`), never an error.
4. **The composer region** — the area allowed to hold media chips, reply context, and badges —
   is the PARENT of the composer's `*RichTextInputContainer` (immediate parent for structural
   fallbacks). All contextual reads (media, reply chip, URLs are composer-scoped) query THIS
   region only; timeline furniture outside it is invisible to extraction.

## 3. Reply context and follow proof

- `isReply` is true when the composer carries a numbered testid (`_1+`) OR a visible reply
  handle is found in the region; `replyToHandle` is set only from what the DOM actually shows
  (registered chip testid, or a profile link whose visible text starts with `@` — the `@` glyph
  is not localized).
- **Follow proof: `replyToFollowedByViewer` is NEVER set from the composer.** Verified absence
  (read-only real-x inspection 2026-10-03, `library/x-dom.md`): the real reply composer region
  exposes no node for viewer-follows-target — no `socialContext`, no `userFollowIndicator`, no
  follow-vocabulary text — for in-network and out-of-network targets alike, before and after
  focus. Badge PROXIMITY to the reply-to line is not follow proof (a generic "Liked by" badge
  shares the line's container and proves nothing; two scrutiny rounds rejected
  fixture-proximity heuristics). `userFollowIndicator` means the REVERSE ("Follows you").
  No follow-state selector is registered in `src/selectors.ts` until a marker is verified with
  this same evidence standard.
- The pure engine still honors a `replyToFollowedByViewer: true` field when a snapshot carries
  one (VAL-DRAFT-028) — but composer-produced snapshots never do, so the reply-mutual
  breakdown honestly reads "not visible" for composer drafts. This is the contract-compliant
  result (architecture.md: follow state "only if visible in DOM; never guessed"), NOT missing
  functionality.

## 4. URL expansion

`urls` holds the draft's URLs, t.co-EXPANDED where the composer markup exposes the destination
(`text` still holds the URL exactly as typed):

1. Parse URLs from `text` (`https?://` or `www.` forms; trailing sentence punctuation stripped;
   deduped, order preserved).
2. For each parsed URL, look for a link INSIDE the composer whose visible text equals the URL
   as typed (the short form). If that chip exposes a destination — `data-expanded-url`
   preferred, else `href` — and the candidate is a different `http(s)` URL, use it.
3. With no visible expansion (no chip, or the chip's href is the same short form), keep the
   short form as written. Expansion is read from markup only — never guessed from the t.co
   token.
