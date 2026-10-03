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
always the same snapshot). **API-key writes stamp a monotonic `keyRevision` the same way**: the
background is the single key writer too (pages send `set-api-key` / `clear-api-key`), and the key
change + its revision persist in one `area.set` — a clear persists the empty string (absent to
every reader) rather than removing the key, so presence and revision can never be observed apart.
Analysis records (`lastAnalysis`) carry no revision either.

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

## Lane (b) — key presence: strictly-newer keyRevision gate, single apply funnel

**Invariant:** the page renders the newest key-presence fact it has been offered, and never
repaints a fact older than one it already applied. At rest the page matches storage (VAL-SETUP-015).

- Every API-key write stamps a monotonic `keyRevision` in the SAME storage write as the key
  change; the background's single writer serializes all key writes, so the counter is a total
  order over them. A fact's presence and revision are captured in ONE storage read, so they never
  disagree: the presence belongs to the revision.
- Every key-presence fact — initial read, a storage event's fresh re-read, the page's own
  save/remove replies, resync rereads — carries the keyRevision of the state it observed and
  passes through ONE strictly-newer gate per page (`keyGate`, a separate `createRevisionGate`
  instance from the settings gate). There is no second render path for key presence.
- Because events AND reads feed the same gate, facts apply in WRITE order whatever their
  completion order: the round-6 defect (a key-set event's fresh read stalling past a key-clear
  event's fact, then completing last and repainting `present` over it) is impossible — the stalled
  fact's revision is older, so the gate rejects it.
- A gate-rejected fact renders nothing. Convergence is the storage subscription's job: every key
  write fires an event whose fresh re-read applies through the same funnel.
- The page's own save/remove replies are gated like any other fact. The write resolved, so its
  fact is true — but if a newer write's fact already applied, the gate rejects the older reply's
  render while the attempt's own status feedback still shows.
- The gate records the first fact it is offered whatever its revision (0 when storage carries no
  counter yet). External writers that bypass the store and write no `keyRevision` produce
  revision-0 facts, which the gate correctly treats as older than any stamped write; there are no
  such writers in the product (all key writes are background-routed).

Options applies this in `readStoreAndRender` (initial read + resync funnel), the key save/remove
replies, and the subscription's key branch, all through one `applyKeyFact` funnel. The popup
applies it inside `refresh()`: the refresh ticket orders whole refreshes, and the key gate orders
the key facts within them (a same-settings-revision refresh still cannot repaint an older key
fact).

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
- Options: delayed key-set EVENT completing after a key-clear event, and the reverse interleaving
  → the page ends at storage's truth both ways (round-6 regressions,
  `test/dom/options-page.test.ts`, "ends absent/present when a delayed key-… event completes …").
- Popup: the same two key-event interleavings through the refresh path
  (`test/dom/popup-page.test.ts`, "ends absent/present when the key-… event refresh completes …").
- Options: resync reread overtaken by a newer write → rejected at completion; resyncs bounded
  (`test/dom/options-page.test.ts`, round-4 regressions).
- Options/popup: delayed save reply after a newer storage change → no stale repaint (round-3
  regressions in both test files).
- Popup: delayed subscription refresh after a newer save reply → the switch never repaints stale
  (`test/dom/popup-page.test.ts`, "drops a delayed subscription refresh …").
- Popup: failed-toggle same-revision restore (`test/dom/popup-page.test.ts`, "reverts the switch
  and reports an error when the write fails").
- Store: settings and key writes each stamp strictly increasing persisted revisions, concurrent
  writes included; a key clear persists the empty string in the SAME write as its revision
  (`test/unit/settings-store.test.ts`).
- Background: key writes from independent page contexts serialize through the protocol layer with
  unique keyRevisions (`test/unit/settings-single-writer.test.ts`).
- E2E: key save/removal stamp an ordered keyRevision and both pages converge; a delayed key-save
  reply resolving after a removal repaints nothing stale (`test/e2e/key-writes.spec.ts`).
