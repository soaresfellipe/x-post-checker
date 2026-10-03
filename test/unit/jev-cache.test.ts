import { describe, expect, it } from 'vitest';
import { createMemoryVerdictCache, createStorageVerdictCache, JEV_CACHE_MAX_ENTRIES } from '@/core/jev-client';
import type { JevCachedVerdict, JevVerdictCache } from '@/core/jev-client';
import { toJevVerdict } from '@/core/heuristic-engine';

const ENTRY: JevCachedVerdict = {
  verdict: toJevVerdict({ ordinal: 3.44, confidence: 0.65, weaknesses: ['Not specific enough.'] }),
  mainWeakness: 'not_specific_enough',
  at: 1_700_000_000_000,
};

/** Minimal storage.local-shaped area over a plain object. */
function makeArea() {
  const data: Record<string, unknown> = {};
  return {
    data,
    area: {
      get: async (keys: string | string[]) => {
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter((key) => key in data).map((key) => [key, data[key]]));
      },
      set: async (items: Record<string, unknown>) => {
        Object.assign(data, items);
      },
    },
  };
}

describe('memory verdict cache', () => {
  it('round-trips entries and reports misses as undefined', async () => {
    const cache = createMemoryVerdictCache();
    await cache.set('a', ENTRY);
    expect(await cache.get('a')).toEqual(ENTRY);
    expect(await cache.get('missing')).toBeUndefined();
  });

  it('evicts the oldest entry beyond the configured capacity', async () => {
    const cache = createMemoryVerdictCache(2);
    await cache.set('a', { ...ENTRY, at: 1 });
    await cache.set('b', { ...ENTRY, at: 2 });
    await cache.set('c', { ...ENTRY, at: 3 });
    expect(await cache.get('a')).toBeUndefined();
    expect(await cache.get('b')).toBeDefined();
    expect(await cache.get('c')).toBeDefined();
  });

  it('defaults to the configured capacity', async () => {
    const cache: JevVerdictCache = createMemoryVerdictCache();
    for (let i = 0; i < JEV_CACHE_MAX_ENTRIES + 5; i += 1) {
      await cache.set(`key-${i}`, { ...ENTRY, at: i });
    }
    expect(await cache.get('key-0')).toBeUndefined();
    expect(await cache.get(`key-${JEV_CACHE_MAX_ENTRIES + 4}`)).toBeDefined();
  });

  it('never hands back a structurally invalid entry', async () => {
    const cache = createMemoryVerdictCache();
    const corrupt = { verdict: { ordinal: 'high' }, mainWeakness: 'made_up', at: 'now' } as unknown;
    await cache.set('bad', corrupt as JevCachedVerdict);
    expect(await cache.get('bad')).toBeUndefined();
  });
});

describe('storage verdict cache (survives service-worker restarts)', () => {
  it('persists entries through the storage area and prunes to capacity by age', async () => {
    const { area, data } = makeArea();
    const cache = createStorageVerdictCache(area, 2);

    await cache.set('a', { ...ENTRY, at: 1 });
    await cache.set('b', { ...ENTRY, at: 2 });
    expect(await cache.get('a')).toEqual({ ...ENTRY, at: 1 });

    await cache.set('c', { ...ENTRY, at: 3 });
    expect(await cache.get('a')).toBeUndefined(); // oldest pruned
    expect(await cache.get('b')).toEqual({ ...ENTRY, at: 2 });
    expect(await cache.get('c')).toEqual({ ...ENTRY, at: 3 });
    expect(Object.keys(data.jevVerdictCache as Record<string, unknown>).sort()).toEqual(['b', 'c']);
  });

  it('drops corrupt persisted entries instead of surfacing them', async () => {
    const { area, data } = makeArea();
    const cache = createStorageVerdictCache(area);
    await cache.set('good', ENTRY);
    data.jevVerdictCache = { good: { verdict: null }, bad: 'garbage' };
    expect(await cache.get('good')).toBeUndefined();
    expect(await cache.get('bad')).toBeUndefined();
  });

  it('keeps both entries when two different drafts settle concurrently', async () => {
    const { area } = makeArea();
    const cache = createStorageVerdictCache(area);
    await Promise.all([
      cache.set('a', { ...ENTRY, mainWeakness: 'weak_hook', at: 1 }),
      cache.set('b', { ...ENTRY, mainWeakness: 'weak_share_trigger', at: 2 }),
    ]);
    expect((await cache.get('a'))?.mainWeakness).toBe('weak_hook');
    expect((await cache.get('b'))?.mainWeakness).toBe('weak_share_trigger');
  });
});
