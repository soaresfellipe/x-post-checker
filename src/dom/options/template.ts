import { NUMERIC_LIMITS } from '@/core/settings-store';

/** Static markup only: no dynamic or user-provided data is ever interpolated into it. */
export const OPTIONS_TEMPLATE = `
<main class="page">
  <h1>AmplifyX settings</h1>

  <section aria-labelledby="key-heading" data-testid="key-section">
    <h2 id="key-heading">Jev API key</h2>
    <p class="hint">AmplifyX uses your own Jev API key (bring your own key). It is stored only on this device, in the extension's local storage, and is never synced.</p>
    <label for="api-key">API key</label>
    <div class="row">
      <input id="api-key" data-testid="api-key-input" type="password" autocomplete="off" spellcheck="false" placeholder="Paste your Jev API key" />
      <button id="toggle-key" data-testid="toggle-key-visibility" type="button" aria-pressed="false" aria-label="Show API key">Show</button>
    </div>
    <div class="row">
      <button id="save-key" data-testid="save-key" type="button">Save key</button>
      <button id="test-connection" data-testid="test-connection" type="button">Test connection</button>
      <button id="remove-key" data-testid="remove-key" type="button">Remove key</button>
    </div>
    <p id="key-status" data-testid="key-status" role="status"></p>
    <p id="save-status" data-testid="save-status" role="status"></p>
    <p id="test-result" data-testid="test-result" role="status"></p>
  </section>

  <section aria-labelledby="prefs-heading" data-testid="preferences-section">
    <h2 id="prefs-heading">Preferences</h2>
    <label class="check"><input id="pref-enabled" data-testid="pref-enabled" type="checkbox" /> Enable AmplifyX</label>
    <label class="check"><input id="pref-autoAnalyze" data-testid="pref-autoAnalyze" type="checkbox" /> Analyze drafts automatically while typing</label>
    <label class="check"><input id="pref-jevForDrafts" data-testid="pref-jevForDrafts" type="checkbox" /> Use Jev AI analysis for drafts</label>
    <label class="check"><input id="pref-jevForTargets" data-testid="pref-jevForTargets" type="checkbox" /> Use Jev AI analysis for reply targets</label>
    <label for="pref-minDraftLength">Minimum draft length to analyze (characters)</label>
    <input id="pref-minDraftLength" data-testid="pref-minDraftLength" type="number" step="1" min="${NUMERIC_LIMITS.minDraftLength.min}" max="${NUMERIC_LIMITS.minDraftLength.max}" />
    <label for="pref-targetThreshold">Reply-target badge threshold (0-100)</label>
    <input id="pref-targetThreshold" data-testid="pref-targetThreshold" type="number" step="1" min="${NUMERIC_LIMITS.targetThreshold.min}" max="${NUMERIC_LIMITS.targetThreshold.max}" />
    <p id="prefs-status" data-testid="prefs-status" role="status"></p>
  </section>

  <section aria-labelledby="privacy-heading" data-testid="privacy-disclosure">
    <h2 id="privacy-heading">Privacy</h2>
    <p>Draft text is sent to api.typesafe.ai when AI analysis runs. Timeline scoring is local: posts you read on your timeline are scored in your browser and are not sent anywhere.</p>
  </section>
</main>
`;
