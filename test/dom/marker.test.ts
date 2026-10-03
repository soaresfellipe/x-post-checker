import { beforeEach, describe, expect, it } from 'vitest';
import { MARKER_HOST_ID, MARKER_TESTID, mountMarker, unmountMarker } from '../../src/dom/marker';

describe('marker', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="react-root"></div>';
  });

  it('mounts a Shadow DOM marker on document.body, outside the app tree', () => {
    const marker = mountMarker(document);
    const host = document.getElementById(MARKER_HOST_ID)!;
    expect(host.parentElement).toBe(document.body);
    expect(host.shadowRoot).not.toBeNull();
    expect(host.shadowRoot!.querySelector(`[data-testid="${MARKER_TESTID}"]`)).toBe(marker);
    expect(document.getElementById('react-root')!.children).toHaveLength(0);
  });

  it('is idempotent', () => {
    const first = mountMarker(document);
    const second = mountMarker(document);
    expect(second).toBe(first);
    expect(document.querySelectorAll(`#${MARKER_HOST_ID}`)).toHaveLength(1);
  });

  it('unmounts cleanly', () => {
    mountMarker(document);
    unmountMarker(document);
    expect(document.getElementById(MARKER_HOST_ID)).toBeNull();
  });
});
