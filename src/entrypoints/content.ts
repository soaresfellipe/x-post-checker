import { onSettingsBroadcast, sendMessage } from '@/core/message-protocol/client';
import { createSettingsSync } from '@/core/message-protocol/settings-sync';
import { createLocalSettingsStore } from '@/core/settings-store';
import { stampMarkerRevision } from '@/dom/marker';
import { applyEnabled } from '@/dom/marker/lifecycle';

export default defineContentScript({
  matches: ['https://x.com/*', 'https://twitter.com/*'],
  runAt: 'document_idle',
  main() {
    const onMounted = (marker: HTMLElement) => {
      void sendMessage('ping', {}).then((response) => {
        marker.dataset.background = response.ok ? 'connected' : 'error';
      });
    };

    // One apply path for both delivery routes: broadcasts (the background's low-latency hint) and
    // storage.onChanged events (authoritative — they fire for every persisted write, so a lost or
    // rejected broadcast still converges). The revision gate inside drops anything not strictly
    // newer than what this tab already applied, whatever order the events arrive in.
    const sync = createSettingsSync((settings, revision) => {
      applyEnabled(settings.enabled, onMounted);
      stampMarkerRevision(revision);
    });

    const store = createLocalSettingsStore();
    onSettingsBroadcast((broadcast) => void sync.accept(broadcast));
    store.subscribe((change) => void sync.accept(change));

    // Initial state for tabs opened before any change; skipped when a change already applied
    // (its state is at least as fresh as this read's).
    void store.getSettings().then(({ enabled }) => {
      if (!sync.hasAppliedAny()) applyEnabled(enabled, onMounted);
    });
  },
});
