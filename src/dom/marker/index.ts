export const MARKER_HOST_ID = 'amplifyx-marker-host';
export const MARKER_TESTID = 'amplifyx-marker';

const STYLE = `
  :host { all: initial; }
  .marker {
    position: fixed; right: 12px; bottom: 12px; z-index: 2147483647;
    padding: 4px 10px; border-radius: 999px;
    background: #1d9bf0; color: #fff;
    font: 600 12px/1.4 system-ui, sans-serif;
  }
`;

/**
 * Mounts the AmplifyX marker in its own Shadow DOM host on document.body (never inside the
 * React-managed x.com tree). Safe to call repeatedly; returns the existing marker if present.
 */
export function mountMarker(doc: Document = document): HTMLElement {
  const existing = doc.getElementById(MARKER_HOST_ID);
  if (existing?.shadowRoot) {
    return existing.shadowRoot.querySelector<HTMLElement>(`[data-testid="${MARKER_TESTID}"]`)!;
  }
  existing?.remove();

  const host = doc.createElement('div');
  host.id = MARKER_HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });

  const style = doc.createElement('style');
  style.textContent = STYLE;
  const marker = doc.createElement('div');
  marker.className = 'marker';
  marker.dataset.testid = MARKER_TESTID;
  marker.textContent = 'AmplifyX';
  shadow.append(style, marker);

  doc.body.append(host);
  return marker;
}

export function unmountMarker(doc: Document = document): void {
  doc.getElementById(MARKER_HOST_ID)?.remove();
}

/**
 * Records the settings revision the host last applied (e.g. from a broadcast or a storage event).
 * Observability only: lets tests and debugging verify a tab reached the store's final revision.
 * No-op while disabled, since the host itself is removed.
 */
export function stampMarkerRevision(revision: number, doc: Document = document): void {
  const host = doc.getElementById(MARKER_HOST_ID);
  if (host) host.dataset.settingsRevision = String(revision);
}
