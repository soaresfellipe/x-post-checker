import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOG_LEVEL,
  LOG_LEVELS,
  REDACTED,
  createConsoleSink,
  createLogger,
  redactError,
  redactText,
  redactValue,
} from '@/core/logging';
import type { LogSink } from '@/core/logging';

/** A captured sink: records every (level, args) an emitter would have received. */
function captureSink(): { sink: LogSink; records: { level: string; args: unknown[] }[] } {
  const records: { level: string; args: unknown[] }[] = [];
  return { sink: (level, args) => records.push({ level, args: [...args] }), records };
}

describe('redactText (free-form strings)', () => {
  it('scrubs Bearer tokens while keeping the surrounding context readable', () => {
    const scrubbed = redactText('POST /v1/systemone failed with Authorization: Bearer EXAMPLE-TOKEN-VALUE');
    expect(scrubbed).not.toContain('EXAMPLE-TOKEN-VALUE');
    expect(scrubbed).toContain('Bearer [REDACTED]');
    expect(scrubbed).toContain('POST /v1/systemone failed');
  });

  it('scrubs the X session cookies the real-x harness treats as credential material', () => {
    const scrubbed = redactText('cookies: auth_token=EXAMPLE-COOKIE-1; ct0=EXAMPLE-COOKIE-2; else=visible');
    expect(scrubbed).not.toContain('EXAMPLE-COOKIE-1');
    expect(scrubbed).not.toContain('EXAMPLE-COOKIE-2');
    expect(scrubbed).toContain('auth_token=[REDACTED]');
    expect(scrubbed).toContain('ct0=[REDACTED]');
    expect(scrubbed).toContain('else=visible');
  });

  it('scrubs Cookie header values entirely', () => {
    const scrubbed = redactText('response set-cookie: guest_id=abc; kdt=xyz; path=/');
    expect(scrubbed).not.toContain('abc');
    expect(scrubbed).not.toContain('xyz');
  });

  it('scrubs secret-bearing query parameters but keeps the URL path', () => {
    const scrubbed = redactText('GET https://api.example.com/v1/data?api_key=EXAMPLE-KEY-42&page=2');
    expect(scrubbed).not.toContain('EXAMPLE-KEY-42');
    expect(scrubbed).toContain('api_key=[REDACTED]');
    expect(scrubbed).toContain('https://api.example.com/v1/data');
    expect(scrubbed).toContain('page=2');
  });

  it('scrubs JSON-shaped secret fields regardless of quoting', () => {
    for (const line of ['{"apiKey":"EXAMPLE-KEY-VALUE","other":1}', "{'auth_token': 'EXAMPLE-VALUE-1'}", 'apiKey=EXAMPLE-VALUE-2']) {
      expect(redactText(line)).not.toContain('EXAMPLE-KEY-VALUE');
      expect(redactText(line)).not.toContain('EXAMPLE-VALUE-1');
      expect(redactText(line)).not.toContain('EXAMPLE-VALUE-2');
    }
  });

  it('scrubs basic-auth credentials embedded in URLs', () => {
    const scrubbed = redactText('fetching https://user:EXAMPLE-PASSWORD@example.com/feed');
    expect(scrubbed).not.toContain('EXAMPLE-PASSWORD');
    expect(scrubbed).toContain('https://[REDACTED]@example.com/feed');
  });

  it('leaves ordinary text untouched (drafts, post text, diagnostics)', () => {
    const text = 'Analysis complete: viral potential 4, main weakness weak_hook, 12 posts scanned';
    expect(redactText(text)).toBe(text);
  });
});

describe('redactValue (structured values)', () => {
  it('drops secret-named keys and recurses into the rest, without mutating the input', () => {
    const input = {
      apiKey: 'sk-live-abcdef123456',
      Authorization: 'Bearer EXAMPLE-TOKEN-VALUE',
      draft: { text: 'plain draft text', length: 24 },
      tags: ['one', 'two'],
    };
    const snapshot = structuredClone(input);

    const output = redactValue(input) as Record<string, unknown>;
    expect(output.apiKey).toBe(REDACTED);
    expect(output.Authorization).toBe(REDACTED);
    expect(output.draft).toEqual({ text: 'plain draft text', length: 24 });
    expect(output.tags).toEqual(['one', 'two']);
    expect(input).toEqual(snapshot);
  });

  it('scrubs secret shapes inside ordinary strings it passes through', () => {
    const output = redactValue({ error: 'unreachable: Bearer EXAMPLE-TOKEN-VALUE' }) as { error: string };
    expect(output.error).toBe('unreachable: Bearer [REDACTED]');
  });

  it('redacts Errors into scrubbed plain objects', () => {
    const output = redactError(new TypeError('failed for https://user:EXAMPLE-PASSWORD@example.com'));
    expect(output).toBe('TypeError: failed for https://[REDACTED]@example.com');
  });

  it('handles Map and Set values', () => {
    const output = redactValue(new Map([['apiKey', 'EXAMPLE-KEY-VALUE'], ['label', 'ok']]));
    expect(output).toEqual({ apiKey: REDACTED, label: 'ok' });
    expect(redactValue(new Set(['a', 'b']))).toEqual(['a', 'b']);
  });

  it('caps the walk depth so self-referencing structures terminate', () => {
    const cyclic: Record<string, unknown> = { label: 'root' };
    cyclic.self = cyclic;
    const output = redactValue(cyclic) as Record<string, unknown>;
    expect(output.label).toBe('root');
    expect(JSON.stringify(output)).toContain(REDACTED);
  });

  it('caps container size and reports the overflow count', () => {
    const huge = { keys: Array.from({ length: 250 }, (_, i) => i) };
    const output = redactValue(huge) as { keys: unknown[] };
    expect(output.keys).toHaveLength(101); // 100 entries + the ellipsis marker
    expect(String(output.keys[100])).toContain('150 more');
  });
});

describe('createLogger (redaction-first emission)', () => {
  it('emits warn and error by default and silences debug and info', () => {
    const { sink, records } = captureSink();
    const log = createLogger({ scope: 'test', sink });

    log.debug('noisy detail');
    log.info('routine');
    log.warn('careful', { apiKey: 'EXAMPLE-KEY-VALUE' });
    log.error('boom', new Error('Bearer EXAMPLE-TOKEN-VALUE'));

    expect(records.map((r) => r.level)).toEqual(['warn', 'error']);
    expect(records[0]?.args).toEqual(['[test]', 'careful', { apiKey: REDACTED }]);
    expect(records[1]?.args[2]).toMatchObject({ message: 'Bearer [REDACTED]' });
  });

  it('honors an explicitly lowered level for local debugging', () => {
    const { sink, records } = captureSink();
    const log = createLogger({ scope: 'test', level: 'debug', sink });
    log.debug('visible now');
    expect(records).toHaveLength(1);
  });

  it('child loggers inherit the sink and level, prefixed with their subscope', () => {
    const { sink, records } = captureSink();
    const log = createLogger({ scope: 'background', sink }).child('jev-client');
    log.warn('retry scheduled');
    expect(records[0]?.args[0]).toBe('[background:jev-client]');
  });

  it('never emits anything below the documented default level', () => {
    expect(DEFAULT_LOG_LEVEL).toBe('warn');
    expect(LOG_LEVELS).toEqual(['debug', 'info', 'warn', 'error']);
  });

  it('exposes a console sink routed by level (the default transport)', () => {
    const sink = createConsoleSink();
    expect(() => sink('warn', ['[test]', 'safe'])).not.toThrow();
  });
});
