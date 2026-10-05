import { onSettingsBroadcast, sendMessage } from '@/core/message-protocol/client';
import { createRevisionGate } from '@/core/message-protocol/broadcast';
import { createSettingsSync } from '@/core/message-protocol/settings-sync';
import { logOrdering } from '@/core/ordering-log';
import { createLocalSettingsStore, DEFAULT_SETTINGS, type Settings } from '@/core/settings-store';
import { E2E_SEED_APPLIED_MESSAGE_TYPE, E2E_SEED_MESSAGE_TYPE, isE2EBuild } from '@/core/test-hooks';
import { stampMarkerRevision } from '@/dom/marker';
import { applyEnabled } from '@/dom/marker/lifecycle';
import { createScoreOverlay } from '@/dom/overlay';
import { createTargetBadges } from '@/dom/badges';
import { createTimelineScanner, stampScannerDiagnostics, type TimelineScanner } from '@/dom/timeline-scanner';
import {
  createComposerWatcher,
  describeComposer,
  stampWatcherDiagnostics,
  type ComposerWatcher,
  type ComposerWatcherOptions,
} from '@/dom/composer-watcher';

export default defineContentScript({
  matches: ['https://x.com/*', 'https://twitter.com/*'],
  runAt: 'document_idle',
  main() {
    // Test-only seed relay (e2e builds): the smoke harness's page driver posts an
    // `amplifyx:e2e-seed` message; this relays it to the background over the typed protocol
    // ('seed-test-state'), whose handler applies it through the real single-writer store paths.
    // The ack is posted back as `amplifyx:e2e-seed-applied` so the driver can await the seed
    // deterministically. Direct storage writes from a content script are NOT used —
    // `storage.onChanged` is unreliable in content scripts (fires for the first write only).
    if (isE2EBuild()) {
      window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        const data = event.data as { type?: unknown; seedId?: unknown; payload?: unknown } | null;
        if (!data || data.type !== E2E_SEED_MESSAGE_TYPE || typeof data.seedId !== 'string') return;
        const payload = (typeof data.payload === 'object' && data.payload !== null ? data.payload : {}) as {
          settings?: Partial<Settings>;
          apiKey?: string;
          jevEndpointOverride?: string;
        };
        void sendMessage('seed-test-state', payload)
          .then((response) =>
            window.postMessage(
              { type: E2E_SEED_APPLIED_MESSAGE_TYPE, seedId: data.seedId, ok: response.ok, error: response.ok ? undefined : response.error },
              '*',
            ),
          )
          .catch((error: unknown) =>
            window.postMessage({ type: E2E_SEED_APPLIED_MESSAGE_TYPE, seedId: data.seedId, ok: false, error: String(error) }, '*'),
          );
      });
    }

    const onMounted = (marker: HTMLElement) => {
      void sendMessage('ping', {}).then((response) => {
        marker.dataset.background = response.ok ? 'connected' : 'error';
      });
      stamp(); // a fresh host (enable cycle) must carry the watcher diagnostics again
    };

    // Composer watcher lifecycle parallels the marker: mounted only while the master switch is
    // on, fully stopped (zero observers, listeners, timers) while off. Settings are read LIVE on
    // every capture so preference changes apply without a tab reload.
    let watcher: ComposerWatcher | null = null;
    let dispatchCount = 0;
    let current: Settings = DEFAULT_SETTINGS;

    // The overlay's key-presence lane: presence only (never the key value — the key must not
    // reach the content script), ordered by the keyRevision token through the same strictly-newer
    // gate pattern the popup and Options use for key facts.
    let keyPresent = false;
    const keyGate = createRevisionGate();

    function stamp(): void {
      const composer = watcher?.getActiveComposer() ?? null;
      stampWatcherDiagnostics(document, {
        state: composer ? 'watching' : 'idle',
        composer: describeComposer(composer),
        dispatches: dispatchCount,
      });
    }

    // The score overlay: its own Shadow-DOM host on document.body, driven by the watcher's
    // captures and the analyze-draft replies. It follows the same enable lifecycle as the marker
    // (mounted only while the master switch is on) and reads live settings + key presence so the
    // panel reflects preference changes without a tab reload.
    const overlay = createScoreOverlay({
      getKeyPresence: () => keyPresent,
      requestAnalysis: () => watcher?.requestAnalysis() ?? false,
      openOptions: () => {
        void sendMessage('open-options-page', {}).catch(() => undefined);
      },
      // The overlay's explicit "Optimize" action (m4-optimizer): the draft goes to the background,
      // whose optimizer cache/coalescing bounds the Jev cost to one API call per unique draft
      // (VAL-OPT-009). The reply settles THIS dispatch by identity; failures are non-blocking
      // (VAL-OPT-010) and the composer text is never touched — copy is the only transfer path.
      requestOptimize: (draft) => {
        void sendMessage('optimize-draft', { draft })
          .then((response) => {
            if (!response.ok) {
              overlay.onOptimizeFailed(draft);
              return;
            }
            overlay.onOptimizeResult(response.data, draft);
          })
          .catch(() => overlay.onOptimizeFailed(draft));
      },
    });

    const dispatchAnalysis: ComposerWatcherOptions['dispatchAnalysis'] = (dispatch) => {
      dispatchCount += 1;
      stamp();
      // The overlay's optimistic local half renders from the capture alone; the reply is the
      // AUTHORITATIVE render (hybrid headline, verdict, failure notices), matched to the current
      // draft by meta.draftHash so stale replies never repaint a newer draft. Refusals and
      // transport failures carry the dispatch's snapshot so the overlay settles THAT dispatch by
      // identity — never the oldest one (VAL-DRAFT-018).
      overlay.onAnalysisDispatched(dispatch.snapshot);
      void sendMessage('analyze-draft', { draft: dispatch.snapshot, trigger: dispatch.trigger })
        .then((response) => {
          if (!response.ok) {
            overlay.onAnalysisFailed(dispatch.snapshot);
            return;
          }
          overlay.onAnalysisResult(response.data, dispatch.snapshot);
        })
        .catch(() => overlay.onAnalysisFailed(dispatch.snapshot));
    };

    function startWatcher(): void {
      if (watcher) return;
      watcher = createComposerWatcher({
        getMinDraftLength: () => current.minDraftLength,
        getAutoAnalyze: () => current.autoAnalyze,
        dispatchAnalysis,
      });
      watcher.onDraft((event) => overlay.onDraftCaptured(event));
      watcher.onUserEdit(() => overlay.collapsePanel());
      watcher.onComposerChange((event) => {
        overlay.onComposerChange(event);
        stamp();
      });
      watcher.start();
      stamp();
    }

    function stopWatcher(): void {
      watcher?.stop();
      watcher = null;
      stamp();
    }

    // Timeline scanner lifecycle parallels the watcher's: scanning (and the badge-host mounts it
    // guarantees) run only while the master switch is on. Scoring dispatches are counted and
    // stamped; target scoring itself is the pure in-tab scorer inside the badges controller
    // (timeline scanning NEVER touches the network — VAL-TARGET-019), and the scanner's diff
    // policy (new/changed only) governs the scoring-dispatch counter.
    let scanner: TimelineScanner | null = null;
    let scannerDispatches = 0;

    // The target badges + popover. The ONLY AI path is the popover's explicit "Deep analysis"
    // action, dispatched per post through the typed background protocol (cached there per post
    // id); every refusal/failure maps to a typed result the popover renders.
    const badges = createTargetBadges({
      getSettings: () => current,
      getKeyPresence: () => keyPresent,
      requestDeepAnalysis: (post) =>
        sendMessage('analyze-target', { post }).then((response) =>
          response.ok ? response.data : { kind: 'error', failure: { kind: 'network', reason: 'unreachable' } },
        ),
      openOptions: () => {
        void sendMessage('open-options-page', {}).catch(() => undefined);
      },
    });

    function startScanner(): void {
      if (scanner) return;
      scanner = createTimelineScanner({
        dispatchScoring: () => {
          scannerDispatches += 1;
          stampScannerDiagnostics(document, { dispatches: scannerDispatches });
        },
      });
      scanner.onScan((event) => badges.onScan(event));
      badges.start(); // running BEFORE the first pass: scanner.start() scans synchronously
      scanner.start();
    }

    function stopScanner(): void {
      badges.stop(); // closes the popover, forgets per-post analysis state
      scanner?.stop(); // removes every badge host — zero extension presence remains
      scanner = null;
      scannerDispatches = 0;
    }

    // One apply path for both delivery routes: broadcasts (the background's low-latency hint) and
    // storage.onChanged events (authoritative — they fire for every persisted write, so a lost or
    // rejected broadcast still converges). The revision gate inside drops anything not strictly
    // newer than what this tab already applied, whatever order the events arrive in.
    const sync = createSettingsSync((settings, revision) => {
      const previous = current;
      current = settings;
      logOrdering({ src: 'sync.apply', revision, enabled: settings.enabled, keyPresent });
      overlay.onSettings(settings, revision);
      // The marker mounts FIRST so the scanner's start-up diagnostics land on it.
      applyEnabled(settings.enabled, onMounted);
      if (settings.enabled) {
        startWatcher();
        startScanner();
      } else {
        stopWatcher();
        stopScanner();
      }
      // Live preference propagation for the badge surfaces: the OPEN popover re-renders against
      // the new settings immediately (AI off wins over a settled verdict, like the overlay), and
      // a threshold change re-gates every visible badge on the next scan (VAL-TARGET-024).
      if (settings.enabled) {
        badges.onSettingsChanged();
        if (previous.targetThreshold !== settings.targetThreshold) scanner?.rescan();
      }
      stampMarkerRevision(revision);
      stamp();
    });

    const store = createLocalSettingsStore();
    onSettingsBroadcast((broadcast) => {
      logOrdering({ src: 'broadcast.recv', revision: broadcast.revision, changedKeys: broadcast.changedKeys });
      void sync.accept(broadcast);
    });
    store.subscribe((change) => {
      // Key-presence facts ride the same storage events (presence only, gated on keyRevision).
      const keyAccepted = keyGate.accept(change.keyRevision);
      logOrdering({
        src: 'storage.event',
        changedKeys: change.changedKeys,
        revision: change.revision,
        keyRevision: change.keyRevision,
        apiKeyPresent: change.apiKeyPresent,
        keyAccepted,
      });
      if (keyAccepted) {
        keyPresent = change.apiKeyPresent;
        // A key-only write changes no settings key (sync.accept ignores it), so WITHOUT this
        // re-render the open tab learns a landed key only at its NEXT natural render — the
        // expanded block can then sit on a stale no-key section while the row (rendered later,
        // from a fresher capture) already shows the verdict. Render NOW so row and block move
        // to the new key fact together (VAL-CROSS-002).
        overlay.onKeyPresenceChanged();
        badges.onSettingsChanged();
      }
      void sync.accept(change);
    });

    // Initial state for tabs opened before any change; skipped when a change already applied
    // (its state is at least as fresh as this read's). The read returns the FULL settings, so the
    // watcher gates start from stored values, not defaults.
    void store.getSettings().then((settings) => {
      if (sync.hasAppliedAny()) return;
      current = settings;
      logOrdering({ src: 'initial.settings', enabled: settings.enabled });
      overlay.onSettings(settings);
      applyEnabled(settings.enabled, onMounted);
      if (settings.enabled) {
        startWatcher();
        startScanner();
      } else {
        stopWatcher();
        stopScanner();
      }
    });    // Initial key-presence fact (presence only). The gate drops it when a storage event already
    // delivered a presence fact at this or a newer keyRevision.
    void store.getApiKeyWithRevision().then(({ apiKeyPresent, keyRevision }) => {
      logOrdering({ src: 'initial.key', keyRevision, apiKeyPresent });
      if (keyGate.accept(keyRevision)) keyPresent = apiKeyPresent;
    });
  },
});
