import { onSettingsBroadcast, sendMessage } from '@/core/message-protocol/client';
import { createSettingsSync } from '@/core/message-protocol/settings-sync';
import { createLocalSettingsStore, DEFAULT_SETTINGS, type Settings } from '@/core/settings-store';
import { stampMarkerRevision } from '@/dom/marker';
import { applyEnabled } from '@/dom/marker/lifecycle';
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

    function stamp(): void {
      const composer = watcher?.getActiveComposer() ?? null;
      stampWatcherDiagnostics(document, {
        state: composer ? 'watching' : 'idle',
        composer: describeComposer(composer),
        dispatches: dispatchCount,
      });
    }

    const dispatchAnalysis: ComposerWatcherOptions['dispatchAnalysis'] = (dispatch) => {
      dispatchCount += 1;
      stamp();
      // Fire-and-forget: the reply belongs to the analysis pipeline (overlay rendering); a
      // missing or failing analyzer must never surface here or break the page.
      void sendMessage('analyze-draft', { draft: dispatch.snapshot, trigger: dispatch.trigger }).catch(
        () => undefined,
      );
    };

    function startWatcher(): void {
      if (watcher) return;
      watcher = createComposerWatcher({
        getMinDraftLength: () => current.minDraftLength,
        getAutoAnalyze: () => current.autoAnalyze,
        dispatchAnalysis,
      });
      watcher.onComposerChange(() => stamp());
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
      if (settings.enabled) startWatcher();
      else stopWatcher();
      applyEnabled(settings.enabled, onMounted);
      stampMarkerRevision(revision);
      stamp();
    });

    const store = createLocalSettingsStore();
    onSettingsBroadcast((broadcast) => void sync.accept(broadcast));
    store.subscribe((change) => void sync.accept(change));

    // Initial state for tabs opened before any change; skipped when a change already applied
    // (its state is at least as fresh as this read's). The read returns the FULL settings, so the
    // watcher gates start from stored values, not defaults.
    void store.getSettings().then((settings) => {
      if (sync.hasAppliedAny()) return;
      current = settings;
      if (settings.enabled) startWatcher();
      else stopWatcher();
      applyEnabled(settings.enabled, onMounted);
    });
  },
});
