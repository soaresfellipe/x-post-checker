import type { DraftSnapshot } from '@/core/draft-snapshot';

/** Builds a full, valid DraftSnapshot; `charCount` always matches the text. */
export function makeDraft(overrides: Partial<DraftSnapshot> = {}): DraftSnapshot {
  const text =
    overrides.text ??
    'I spent 30 days replacing my complicated productivity system with one daily checklist. I finish more work now.';
  return {
    text,
    hashtags: [],
    urls: [],
    hasMedia: false,
    isReply: false,
    charCount: text.length,
    capturedAt: 1_700_000_000_000,
    ...overrides,
  };
}
