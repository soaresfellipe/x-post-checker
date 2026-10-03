import { onSettingsBroadcast, sendMessage } from '@/core/message-protocol/client';
import { createSettingsBroadcastReceiver } from '@/core/message-protocol/broadcast';
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

    // Broadcasts are independent sendMessage calls, so a delayed "off" from a rapid off/on toggle
    // can arrive after a newer "on"; the receiver drops anything not newer than what was applied.
    const receiver = createSettingsBroadcastReceiver();
    let broadcastSeen = false;
    onSettingsBroadcast((broadcast) => {
      if (!receiver.accept(broadcast)) return;
      broadcastSeen = true;
      applyEnabled(broadcast.settings.enabled, onMounted);
    });
    void createLocalSettingsStore()
      .getSettings()
      .then(({ enabled }) => {
        if (!broadcastSeen) applyEnabled(enabled, onMounted);
      });
  },
});
