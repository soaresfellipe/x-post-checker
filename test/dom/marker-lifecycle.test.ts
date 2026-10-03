import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKER_HOST_ID } from '../../src/dom/marker';
import { applyEnabled } from '../../src/dom/marker/lifecycle';

describe('marker lifecycle', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('mounts when enabled and removes everything when disabled', () => {
    applyEnabled(true, undefined, document);
    expect(document.getElementById(MARKER_HOST_ID)).not.toBeNull();
    applyEnabled(false, undefined, document);
    expect(document.getElementById(MARKER_HOST_ID)).toBeNull();
  });

  it('reports a newly mounted marker once, not on redundant enables', () => {
    const onMounted = vi.fn();
    applyEnabled(true, onMounted, document);
    applyEnabled(true, onMounted, document);
    expect(onMounted).toHaveBeenCalledTimes(1);
    applyEnabled(false, onMounted, document);
    applyEnabled(true, onMounted, document);
    expect(onMounted).toHaveBeenCalledTimes(2);
  });

  it('disabling with nothing mounted is a no-op', () => {
    expect(() => applyEnabled(false, undefined, document)).not.toThrow();
  });
});
