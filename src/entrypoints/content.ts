import { sendMessage } from '@/core/message-protocol/client';
import { mountMarker } from '@/dom/marker';

export default defineContentScript({
  matches: ['https://x.com/*', 'https://twitter.com/*'],
  runAt: 'document_idle',
  main() {
    const marker = mountMarker();
    void sendMessage('ping', {}).then((response) => {
      marker.dataset.background = response.ok ? 'connected' : 'error';
    });
  },
});
