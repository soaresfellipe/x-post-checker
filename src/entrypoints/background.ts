import { createLocalSettingsStore } from '@/core/settings-store';
import { broadcastToTabs, createSettingsBroadcast } from '@/core/message-protocol/broadcast';
import { SETTINGS_KEYS } from '@/core/settings-store';
import { handleRequest, isRequest } from '@/core/message-protocol';
import { createBackgroundHandlers } from '@/core/message-protocol/handlers';
import { createAnalyzerService } from '@/core/analyzer';
import { createTargetAnalysisService } from '@/core/target-analysis';
import { createOptimizerService } from '@/core/optimizer';
import { createJevClient, createStorageVerdictCache, createStorageTargetVerdictCache, createStorageOptimizerCache } from '@/core/jev-client';
import { isE2EBuild, JEV_ENDPOINT_OVERRIDE_STORAGE_KEY } from '@/core/test-hooks';
import { setJevEndpointOverrideForTests } from '@/core/jev-client/transport';
export default defineBackground(() => {
  // Test-only seam (e2e builds): the Jev endpoint override is read live from storage so the
  // Firefox smoke harness can steer every Jev exchange to the fixture mock. Release builds never
  // register the listener and the override setter is inert outside the e2e mode.
  if (isE2EBuild()) {
    const applyOverride = (value: unknown): void => {
      setJevEndpointOverrideForTests(typeof value === 'string' && value.length > 0 ? value : undefined);
    };
    void browser.storage.local.get(JEV_ENDPOINT_OVERRIDE_STORAGE_KEY).then((stored) => {
      applyOverride(stored[JEV_ENDPOINT_OVERRIDE_STORAGE_KEY]);
    });
    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !(JEV_ENDPOINT_OVERRIDE_STORAGE_KEY in changes)) return;
      applyOverride(changes[JEV_ENDPOINT_OVERRIDE_STORAGE_KEY]?.newValue);
    });
  }

  // ONE store instance for the whole background: it is the extension's SINGLE settings writer.
  // Popup and Options no longer write storage directly — they send `set-settings` requests, which
  // this store serializes and stamps with the revision in the same storage write. (Its listeners
  // are registered synchronously below: Chrome's service worker and Firefox's event page are both
  // suspended and restarted, so no listener may depend on module-level state.)
  const store = createLocalSettingsStore();

  // The analysis pipeline. The verdict cache is persisted in storage.local so it survives
  // service-worker suspension (Chrome idles MV3 workers out after ~30s): re-analyzing an
  // identical draft later in the session is served from cache, not paid for again. The rate
  // window persists the same way — a restarted worker rehydrates the send count, so the
  // requests-per-window maximum holds across suspension.
  const jevClient = createJevClient({
    cache: createStorageVerdictCache(browser.storage.local),
    targetCache: createStorageTargetVerdictCache(browser.storage.local),
    optimizerCache: createStorageOptimizerCache(browser.storage.local),
    rateWindowArea: browser.storage.local,
  });
  const analyzer = createAnalyzerService({ store, jev: jevClient });
  const targetAnalyzer = createTargetAnalysisService({ store, jev: jevClient });
  const optimizer = createOptimizerService({ store, jev: jevClient });
  const handlers = createBackgroundHandlers({
    store,
    analyzer,
    targetAnalyzer,
    optimizer,
    // Content scripts cannot call runtime.openOptionsPage; their "Connect Jev" prompt routes here.
    openOptionsPage: () => browser.runtime.openOptionsPage(),
    // Test-only (e2e builds): the smoke harness's seed, applied through the REAL single-writer
    // paths. The endpoint override is applied to the live transport AND persisted for later
    // worker restarts (the startup read below restores it).
    ...(isE2EBuild() && {
      seedTestState: async ({ settings, apiKey, jevEndpointOverride, openOptionsPage }) => {
        if (settings !== undefined) await store.setSettings(settings);
        let keyRevision = 0;
        if (apiKey !== undefined) {
          keyRevision = (apiKey === '' ? await store.clearApiKey() : await store.setApiKey(apiKey)).keyRevision;
        }
        if (jevEndpointOverride !== undefined) {
          setJevEndpointOverrideForTests(jevEndpointOverride === '' ? undefined : jevEndpointOverride);
          await browser.storage.local.set({ [JEV_ENDPOINT_OVERRIDE_STORAGE_KEY]: jevEndpointOverride });
        }
        if (openOptionsPage) {
          // Firefox smoke harness: Marionette cannot navigate to extension pages, so the Options
          // page is opened through the extension's own runtime API (same path as the popup).
          browser.runtime.openOptionsPage().catch(() => {});
        }
        const settingsRevision = (await store.getSettingsWithRevision()).revision;
        return { seeded: true, settingsRevision, keyRevision };
      },
    }),
  });

  browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isRequest(message)) return false;
    void handleRequest(message, handlers).then(sendResponse);
    return true;
  });

  // Fans every persisted settings change out to tabs as a low-latency hint. The envelope carries
  // the write's revision so tabs can reject out-of-order deliveries; the authoritative
  // reconciliation path is storage.onChanged, which fires in each tab regardless of this delivery.
  store.subscribe(({ settings, changedKeys, revision }) => {
    const settingsKeys = changedKeys.filter((key) => (SETTINGS_KEYS as readonly string[]).includes(key));
    if (settingsKeys.length === 0) return;
    void broadcastToTabs(browser.tabs, createSettingsBroadcast(settings, settingsKeys, revision));
  });
});
