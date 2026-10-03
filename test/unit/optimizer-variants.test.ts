import { describe, expect, it } from 'vitest';
import { generateHookVariants } from '@/core/optimizer/variants';

/**
 * Hook variant generation (VAL-OPT-003): Jev is a decision model — it cannot write text — so the
 * variants are SELF-GENERATED as deterministic structural rewrites of the draft's own words, and
 * Jev (noul, verified live) judges which rewrites out-earn the original opening. These tests pin
 * the structural guarantees: distinct opening shapes, meaning preservation, determinism.
 */
const DRAFT =
  'I spent 30 days replacing my complicated productivity system with one daily checklist. I finish more work now.';

describe('hook variant generation (VAL-OPT-003)', () => {
  it('generates at least one variant for any draft', () => {
    expect(generateHookVariants('Hello world, this is a test draft.').length).toBeGreaterThanOrEqual(1);
  });

  it('generates a question variant for a declarative I-draft that opens differently', () => {
    const question = generateHookVariants(DRAFT).find((variant) => variant.kind === 'question');
    expect(question).toBeTruthy();
    expect(question!.text.startsWith('What happened when I spent 30 days')).toBe(true);
    expect(question!.text.endsWith('?')).toBe(false); // the question is the LEAD; the draft body follows
    expect(question!.text).toContain('I finish more work now.');
  });

  it('skips the question variant when the draft already opens with a question', () => {
    const variants = generateHookVariants('Why did nobody tell me this sooner? I wasted years on tools.');
    expect(variants.find((variant) => variant.kind === 'question')).toBeUndefined();
  });

  it('generates a number-lead variant when the draft contains a number past its opening', () => {
    const number = generateHookVariants(DRAFT).find((variant) => variant.kind === 'number');
    expect(number).toBeTruthy();
    expect(number!.text.startsWith('30 days.')).toBe(true);
  });

  it('skips the number variant when the draft opens with the number itself', () => {
    const variants = generateHookVariants('30 days ago I changed everything. It worked.');
    expect(variants.find((variant) => variant.kind === 'number')).toBeUndefined();
  });

  it('generates a story variant leading with a narrative teaser', () => {
    const story = generateHookVariants(DRAFT).find((variant) => variant.kind === 'story');
    expect(story).toBeTruthy();
    expect(story!.text.startsWith("Here's what happened:")).toBe(true);
    expect(story!.text).toContain(DRAFT);
  });

  it('does not double the story teaser when the draft already starts with it', () => {
    const variants = generateHookVariants("Here's what happened: I tried the checklist. It worked.");
    const story = variants.find((variant) => variant.kind === 'story');
    expect(story).toBeUndefined();
    expect(variants.length).toBeGreaterThanOrEqual(1); // another kind still applies
  });

  it('generates a claim variant that moves the concluding sentence to the front', () => {
    const claim = generateHookVariants(DRAFT).find((variant) => variant.kind === 'claim');
    expect(claim).toBeTruthy();
    expect(claim!.text.startsWith('I finish more work now.')).toBe(true);
    expect(claim!.text).toContain('I spent 30 days');
  });

  it('skips the claim variant for a single-sentence draft (nothing to reorder)', () => {
    const variants = generateHookVariants('I spent 30 days replacing my whole system with one checklist.');
    expect(variants.find((variant) => variant.kind === 'claim')).toBeUndefined();
  });

  it('every variant opens differently from the original (no trivial rewrites)', () => {
    for (const variant of generateHookVariants(DRAFT)) {
      expect(variant.text.startsWith(DRAFT)).toBe(false);
      expect(variant.text.slice(0, 16)).not.toBe(DRAFT.slice(0, 16));
    }
  });

  it('preserves the draft substance: every variant keeps every sentence of the original', () => {
    for (const variant of generateHookVariants(DRAFT)) {
      expect(variant.text).toContain('I spent 30 days replacing my complicated productivity system with one daily checklist');
      expect(variant.text).toContain('I finish more work now');
    }
  });

  it('is deterministic: the same draft produces the same variants in the same order', () => {
    expect(generateHookVariants(DRAFT)).toEqual(generateHookVariants(DRAFT));
  });
});
