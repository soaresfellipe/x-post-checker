import { onSettingsBroadcast, sendMessage } from '@/core/message-protocol/client';
import { createLocalSettingsStore } from '@/core/settings-store';
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

    // A broadcast is newer than the initial storage read, so it must win if both race.
    let broadcastSeen = false;
    onSettingsBroadcast(({ settings }) => {
      broadcastSeen = true;
      applyEnabled(settings.enabled, onMounted);
    });
    void createLocalSettingsStore()
      .getSettings()
      .then(({ enabled }) => {
        if (!broadcastSeen) applyEnabled(enabled, onMounted);
      });
  },
});
