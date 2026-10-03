import { onSettingsBroadcast, sendMessage } from '@/core/message-protocol/client';
import { createRevisionGate } from '@/core/message-protocol/broadcast';
import { createSettingsSync } from '@/core/message-protocol/settings-sync';
import { createLocalSettingsStore, DEFAULT_SETTINGS, type Settings } from '@/core/settings-store';
import { stampMarkerRevision } from '@/dom/marker';
import { applyEnabled } from '@/dom/marker/lifecycle';
import { createScoreOverlay } from '@/dom/overlay';
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

    // One apply path for both delivery routes: broadcasts (the background's low-latency hint) and
    // storage.onChanged events (authoritative — they fire for every persisted write, so a lost or
    // rejected broadcast still converges). The revision gate inside drops anything not strictly
    // newer than what this tab already applied, whatever order the events arrive in.
    const sync = createSettingsSync((settings, revision) => {
      current = settings;
      overlay.onSettings(settings, revision);
      if (settings.enabled) startWatcher();
      else stopWatcher();
      applyEnabled(settings.enabled, onMounted);
      stampMarkerRevision(revision);
      stamp();
    });

    const store = createLocalSettingsStore();
    onSettingsBroadcast((broadcast) => void sync.accept(broadcast));
    store.subscribe((change) => {
      // Key-presence facts ride the same storage events (presence only, gated on keyRevision).
      if (keyGate.accept(change.keyRevision)) keyPresent = change.apiKeyPresent;
      void sync.accept(change);
    });

    // Initial state for tabs opened before any change; skipped when a change already applied
    // (its state is at least as fresh as this read's). The read returns the FULL settings, so the
    // watcher gates start from stored values, not defaults.
    void store.getSettings().then((settings) => {
      if (sync.hasAppliedAny()) return;
      current = settings;
      overlay.onSettings(settings);
      if (settings.enabled) startWatcher();
      else stopWatcher();
      applyEnabled(settings.enabled, onMounted);
    });

    // Initial key-presence fact (presence only). The gate drops it when a storage event already
    // delivered a presence fact at this or a newer keyRevision.
    void store.getApiKeyWithRevision().then(({ apiKeyPresent, keyRevision }) => {
      if (keyGate.accept(keyRevision)) keyPresent = apiKeyPresent;
    });
  },
});
