import { createLocalSettingsStore } from '@/core/settings-store';
import { sendMessage } from '@/core/message-protocol/client';
import { mountOptionsPage } from '@/dom/options';

const root = document.getElementById('app');
if (!root) throw new Error('Options root element is missing');

void mountOptionsPage(root, {
  store: createLocalSettingsStore(),
  testConnection: async (attemptId, apiKey) => {
    const response = await sendMessage('test-connection', { attemptId, ...(apiKey ? { apiKey } : {}) });
    if (!response.ok) throw new Error(response.error);
    return response.data;
  },
});
