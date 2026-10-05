/**
 * ThemeDetector (M6, Design 1b): maps X's body background to one of the three extension themes
 * and follows live switches. Detection reads `getComputedStyle(document.body).backgroundColor`
 * at mount and inside a MutationObserver on the body `style` attribute (the representation X
 * actually mutates — verified read-only on real x.com 2026-10-05, `library/x-dom.md` fact 4d:
 * the body background is an inline `background-color` style). Unknown backgrounds fall back to
 * light. Subscribers are called only on actual theme CHANGES.
 */
import type { XTheme } from './tokens';

/** Maps a CSS background-color value to an X theme; anything unknown falls back to light. */
export function mapBackgroundColor(color: string): XTheme {
  const normalized = color.replace(/\s+/g, '').toLowerCase();
  if (normalized === '#ffffff' || normalized === 'rgb(255,255,255)') return 'light';
  if (normalized === '#15202b' || normalized === 'rgb(21,32,43)') return 'dim';
  if (normalized === '#000000' || normalized === 'rgb(0,0,0)') return 'lights-out';
  return 'light';
}

export interface ThemeDetectorOptions {
  doc?: Document;
}

export type ThemeListener = (theme: XTheme) => void;

export class ThemeDetector {
  private readonly doc: Document;
  private observer: MutationObserver | null = null;
  private current: XTheme;
  private readonly listeners = new Set<ThemeListener>();

  constructor(options: ThemeDetectorOptions = {}) {
    this.doc = options.doc ?? document;
    this.current = this.read();
  }

  /** Re-reads the live body background; emits to subscribers only on an actual change. */
  private read(): XTheme {
    return mapBackgroundColor(this.doc.defaultView?.getComputedStyle(this.doc.body).backgroundColor ?? '');
  }

  private refresh = (): void => {
    const next = this.read();
    if (next === this.current) return;
    this.current = next;
    for (const listener of this.listeners) listener(next);
  };

  getTheme(): XTheme {
    return this.current;
  }

  subscribe(listener: ThemeListener): () => void {
    this.listeners.add(listener);
    this.observer ??= new MutationObserver(this.refresh);
    this.observer.observe(this.doc.body, { attributes: true, attributeFilter: ['style'] });
    return () => {
      this.listeners.delete(listener);
    };
  }

  destroy(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.listeners.clear();
  }
}
