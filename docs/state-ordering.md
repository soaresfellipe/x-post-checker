# State-ordering spec — Options and popup pages

How the two extension pages order concurrent state facts so that what they render never regresses
behind storage. Both pages conform to exactly these lanes; scrutiny review verifies against this
document.

Implementations: `src/dom/options/options-page.ts`, `src/dom/popup/popup-page.ts`.
Shared gate: `createRevisionGate` in `src/core/message-protocol/broadcast.ts`.
Store contracts: `src/core/settings-store/{store,types}.ts`.

## Fact sources

Each page is offered state facts from four sources, in no guaranteed order:

1. **Initial read** — one full store read at mount.
2. **Storage events** — `store.subscribe` / `store.subscribeLastAnalysis`. The store re-reads the
   affected values fresh at delivery, so an event's facts are at least as new as the write that
   fired it.
3. **Save replies** — the page's own write path (`deps.saveSettings`), resolving with the
   persisted settings and the revision the write stamped.
4. **Re-reads** — a page-initiated full read issued when a fact is rejected (Options resync,
   popup refresh).

Writes: settings writes stamp a monotonic `settingsRevision` (the background is the single
settings writer; settings + revision persist in one `area.set`, so revision N's settings are
always the same snapshot). **API-key writes carry no revision.** Analysis records
(`lastAnalysis`) carry no revision either.

## Lane (a) — settings: strictly-newer revision gate, single apply funnel

**Invariant:** the page renders the newest settings snapshot it has been offered, and never
repaints a snapshot older than one it already applied.

- Every settings snapshot (initial read, storage event, save reply, re-read) passes through ONE
  revision-gated funnel per page; there is no second render path for settings.
- `revisionGate.accept(revision)` admits only revisions strictly newer than everything applied so
  far; the gate never records a rejected revision.
- A gate-rejected snapshot renders nothing. Convergence to the store is the storage
  subscription's job: every settings write fires an event, whose fresh re-read applies through
  the same funnel. Rejected read funnels never schedule another read (bounded resyncs).
- **Same-revision re-read exception:** a full re-read whose revision equals `gate.lastApplied()`
  may render — nothing newer has applied (it is a fresh observation of the current state), and
  same-revision snapshots are identical by construction. This is what restores the popup switch
  after a failed toggle and lets key-only events re-render the popup.

Options applies this in `readStoreAndRender` (initial read + resync funnel), `applySaveReply`,
and the subscription's settings branch. The popup applies it in `refresh` (ticket check, then
`accept(revision) || revision === revisionGate.lastApplied()`) and the toggle reply.

## Lane (b) — key presence: event-first, never regressed by a delayed read

**Invariant:** once a storage event has applied a key-presence fact, no later-completing read may
repaint key presence. Key-only events re-read fresh at delivery, so the lane converges to
storage's truth and stays there.

- Key writes advance no revision, so the settings gate cannot order this lane; it keeps its own
  ordering: a page-level `keyEventApplied` flag (Options).
- The storage subscription applies every key-touching event's fresh presence fact and sets the
  flag. Event facts always apply, whatever the settings revision is doing.
- Reads (initial read, resync rereads) render their key observation only while no key event has
  applied yet; afterwards they leave the lane untouched — their observation began before the
  event delivered, so the event's fact is the newer one. A gate-rejected read may still render
  its key fact (the lanes are independent).
- The page's own save/remove feedback renders its confirmed outcome directly (the write resolved,
  so the key IS in that state); the write's own storage event then re-applies the fresh fact.
- Popup: key presence rides the full `refresh()` (ticket-ordered), so a delayed refresh either
  still holds the newest available fact (ticket current) or is dropped entirely (ticket stale);
  same-revision refreshes keep key-only events rendering.

## Lane (c) — analysis: ticket ordering, no settings interplay

**Invariant:** the last-analysis line reflects the newest analysis record delivered to the page,
and analysis updates never reorder settings state (nor the reverse).

- Popup only (Options shows no analysis): `store.subscribeLastAnalysis` events trigger a fresh
  full `refresh()`; the monotonic refresh ticket drops any refresh superseded by a newer one, so
  facts apply in refresh-start order.
- Analysis facts are ordered by the refresh ticket alone — the revision gate does not order them,
  and a settings save reply never renders analysis state.
- The settings part of a refresh follows lane (a). When a refresh is dropped as settings-stale,
  its analysis render is dropped with it: any newer analysis fact arrives with its own event and
  its own refresh.

## Pinned interleavings (regression tests)

- Options: delayed initial key-presence read vs an earlier key-only event → the page ends at
  storage's truth (`test/dom/options-page.test.ts`, "does not regress key presence …").
- Options: key-only events apply fresh at delivery (`test/dom/options-page.test.ts`).
- Options: resync reread overtaken by a newer write → rejected at completion; resyncs bounded
  (`test/dom/options-page.test.ts`, round-4 regressions).
- Options/popup: delayed save reply after a newer storage change → no stale repaint (round-3
  regressions in both test files).
- Popup: delayed subscription refresh after a newer save reply → the switch never repaints stale
  (`test/dom/popup-page.test.ts`, "drops a delayed subscription refresh …").
- Popup: failed-toggle same-revision restore (`test/dom/popup-page.test.ts`, "reverts the switch
  and reports an error when the write fails").
