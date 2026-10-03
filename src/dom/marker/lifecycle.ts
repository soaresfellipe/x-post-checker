import { MARKER_HOST_ID, mountMarker, unmountMarker } from './index';

/**
 * Keeps the marker in step with the master switch. Enabling after disabling mounts a fresh
 * marker; disabling removes it so nothing of AmplifyX remains in the page.
 */
export function applyEnabled(enabled: boolean, onMounted?: (marker: HTMLElement) => void, doc: Document = document): void {
  if (!enabled) {
    unmountMarker(doc);
    return;
  }
  const alreadyMounted = doc.getElementById(MARKER_HOST_ID) !== null;
  const marker = mountMarker(doc);
  if (!alreadyMounted) onMounted?.(marker);
}
