# State-ordering spec — Options, popup, and draft-analysis state

How the extension orders concurrent state facts so that what it renders never regresses behind
storage or behind newer in-flight work. The two pages conform to lanes (a)–(c); the draft
overlay's terminal states to lane (d) and the Jev client's durable rate accounting to lane (e) —
both extending this document's analysis-ordering family. Scrutiny review verifies against this
document.

Implementations: `src/dom/options/options-page.ts`, `src/dom/popup/popup-page.ts`,
`src/dom/overlay/{overlay,view-model}.ts`, `src/core/jev-client/rate-window.ts`.
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
Analysis records (`lastAnalysis`) carry no revision either, but they are ordered by the
analysis `at` stamp instead (lane (c)): the background's single writer serializes analysis
records through the same write chain as the settings/key writes AND applies a strictly-newer
`at` recency gate, so an older completion can never overwrite a newer one in storage; the
popup's render path applies a monotonic `at` gate on top.

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

## Lane (c) — analysis: `at` recency gate, no settings interplay

**Invariant:** the last-analysis line reflects the newest analysis record delivered to the page,
and analysis updates never reorder settings state (nor the reverse).

- Writes are ordered at the source: `recordAnalysis` joins the background's single-writer chain
  (the settings/key write chain, promise-serialized) and applies a strictly-newer `at` recency
  gate — a stored record is replaced only by a strictly newer completion, so a delayed OLDER
  completion (analysis A's stalled write landing after B's) can never overwrite the newer
  outcome, in either interleaving order.
- Popup only (Options shows no analysis): `store.subscribeLastAnalysis` events trigger a fresh
  full `refresh()`; the monotonic refresh ticket drops any refresh superseded by a newer one, so
  facts apply in refresh-start order.
- The page ALSO gates analysis facts on their `at` stamp (the settings lanes' pattern): a record
  older than the one already applied never repaints — this is the defense for facts that bypass
  the background's gated recorder (external/direct storage writers). A same-`at` re-read is a
  fresh observation of the current record and may render; the empty state renders only before
  any record has been applied.
- A settings save reply never renders analysis state.
- The settings part of a refresh follows lane (a). When a refresh is dropped as settings-stale,
  its analysis render is dropped with it: any newer analysis fact arrives with its own event and
  its own refresh.

## Lane (d) — draft terminal state: per-draft ownership (overlay)

**Invariant:** every dispatched draft reaches exactly ONE terminal render — analyzed, failed, or
superseded — and a settling dispatch affects only the draft identity it belongs to. No draft ever
spins forever, and no draft silently downgrades to the ready phase
(VAL-DRAFT-018; `src/dom/overlay/overlay.ts`, `src/dom/overlay/view-model.ts`).

- Dispatches, results, and transport failures are keyed by the draft identity (`draftCacheKey`).
  A settling dispatch may only mutate the state that belongs to ITS identity: its own pending
  entry, its own failure entry, its own reply. It never settles "whatever is oldest".
- Terminal transport failures are tracked PER DRAFT (a set of hashes), never in a single slot.
  (A single slot let an older failing draft overwrite the current draft's failure record and
  render it as ready — silently deleting both its local score and its explicit error notice.)
- A result or failure for a NON-CURRENT draft never mutates what the current draft renders: the
  current draft's render reads only its own pending entry, its own failure entry, and its own
  matching reply. A non-current success retires only its own hash's failure and never claims the
  reply slot (VAL-DRAFT-011's discard rule).
- Capture prunes: when a new draft is captured, terminal state belonging to other identities is
  dropped (bounded bookkeeping). The captured draft's own prior failure survives, so an identical
  retype still shows its last terminal outcome until a fresh result retires it.
- Precedence for the current draft's Jev half: matching reply > own transport failure >
  pending spinner. The draft's OWN success clears its failure (success after failure recovers);
  a draft's failure is never lifted by another draft's outcome.
- A per-draft failure renders the honest degraded state: the local score stays usable with an
  explicit transport-error notice — the failure never throws into the UI and never fabricates a
  verdict.

Pinned interleavings (regression tests, `test/dom/overlay.test.ts`, "transport-failure identity"):

- B (current) fails first, then older A fails → B keeps its local score and explicit error, never
  a downgrade to ready (the round-2 blocker regression).
- A fails first while B is pending → B unaffected; B's own later failure settles B.
- B settles with a verdict, then older A's transport fails late → B's verdict is intact
  (failure after success).
- B's transport fails, then its own re-dispatch (identical retype) succeeds → the failure is
  cleared and the verdict renders (success after failure).

## Lane (e) — durable rate accounting: fail closed (Jev client)

**Invariant:** the configured requests-per-window maximum is never exceeded — not by retries, not
across MV3 service-worker suspension, and not when storage fails (VAL-DRAFT-031;
`src/core/jev-client/rate-window.ts`, wired to `storage.local` in the background).

- Every transport attempt (retries included) persists a send stamp BEFORE the send starts,
  write-serialized (the verdict-cache pattern), and a recreated client rehydrates the persisted
  window at creation. These are the M1 single-writer/write-order invariants applied to the rate
  window, so a restarted worker inherits the in-window send count.
- FAIL CLOSED: when durable rate accounting cannot be established — the hydration read rejects,
  or a reservation's write rejects — the limiter DENIES the send with the existing typed
  `rate-limited` failure. It never sends with an unpersisted stamp, and it never silently drops
  to in-memory-only accounting for a send: an unpersisted stamp is exactly the hole an MV3
  restart walks through to exceed the hard maximum.
- A denied reservation rolls its in-memory stamp back, so the in-memory window mirrors the
  durable one (what a restarted worker would rehydrate).
- The denial is the analyzer's honest degraded outcome (`jevStatus: 'rate-limited'`): the overlay
  shows its explicit error notice while the local score stays usable — no thrown error reaches
  the UI, and the render obeys lane (d)'s ownership rules as usual.

Pinned interleavings (regression tests, `test/unit/jev-client.test.ts`, "persistent rate window"):

- Rejected hydration read → typed rate-limited denial, zero transport calls.
- Rejected reservation write → typed denial, zero transport calls.
- Rejected writes plus a fresh client (simulated restart) inside the window → still denied; the
  ceiling held across both client instances.
- Storage breaks after an earlier successful send → the unpersistable reservation is denied, and
  the restarted client (which rehydrated the persisted stamp) still denies: the real-send count
  never exceeds the configured maximum.

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
- Store: analysis records are write-serialized with a strictly-newer `at` gate — a delayed older
  completion never overwrites a newer record, in either held-write interleaving, and equal-`at`
  records never displace the stored one (`test/unit/last-analysis.test.ts`).
- Popup: a delayed older analysis record delivered after a newer one was applied repaints
  nothing, and the reverse interleaving still converges on the newest record
  (`test/dom/popup-page.test.ts`).
- E2E: after a real background analysis, a deliberately delayed older `lastAnalysis` write never
  regresses the popup's line, while a genuinely newer completion still applies
  (`test/e2e/last-analysis-ordering.spec.ts`).
- Background: key writes from independent page contexts serialize through the protocol layer with
  unique keyRevisions (`test/unit/settings-single-writer.test.ts`).
- E2E: key save/removal stamp an ordered keyRevision and both pages converge; a delayed key-save
  reply resolving after a removal repaints nothing stale (`test/e2e/key-writes.spec.ts`).
