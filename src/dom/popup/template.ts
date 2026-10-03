/** Static markup only: no dynamic or user-provided data is ever interpolated into it. */
export const POPUP_TEMPLATE = `
<main class="popup">
  <h1>AmplifyX</h1>

  <label class="master" for="master-toggle">
    <input id="master-toggle" data-testid="master-toggle" type="checkbox" role="switch" />
    <span id="master-label" data-testid="master-label">AmplifyX is on</span>
  </label>
  <p id="toggle-error" data-testid="toggle-error" role="alert"></p>

  <dl class="status" data-testid="status-area">
    <div>
      <dt>Jev API key</dt>
      <dd id="key-indicator" data-testid="key-indicator"></dd>
    </div>
    <div>
      <dt>Last analysis</dt>
      <dd id="last-analysis" data-testid="last-analysis"></dd>
    </div>
  </dl>

  <button id="open-options" data-testid="open-options" type="button">Open Options</button>
</main>
`;
