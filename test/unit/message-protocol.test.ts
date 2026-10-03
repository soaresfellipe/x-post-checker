import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  createRequest,
  handleRequest,
  isRequest,
  type Handlers,
} from '../../src/core/message-protocol';
import { DEFAULT_SETTINGS } from '../../src/core/settings-store';

const handlers: Handlers = {
  ping: () => ({ pong: true, protocolVersion: PROTOCOL_VERSION }),
  'test-connection': ({ attemptId }) => ({ attemptId, result: { status: 'no-key' } }),
  'set-settings': ({ update }) => ({
    settings: { ...DEFAULT_SETTINGS, ...update },
    settingsRevision: 1,
  }),
  'set-api-key': ({ key }) => ({ apiKeyPresent: true, keyRevision: key.length }),
  'clear-api-key': () => ({ apiKeyPresent: false, keyRevision: 0 }),
};

describe('message protocol', () => {
  it('builds versioned request envelopes', () => {
    expect(createRequest('ping', {})).toEqual({ v: PROTOCOL_VERSION, type: 'ping', payload: {} });
  });

  it('recognizes well-formed requests only', () => {
    expect(isRequest(createRequest('ping', {}))).toBe(true);
    expect(isRequest(createRequest('set-api-key', { key: 'k' }))).toBe(true);
    expect(isRequest(createRequest('clear-api-key', {}))).toBe(true);
    expect(isRequest(null)).toBe(false);
    expect(isRequest({ type: 'ping' })).toBe(false);
    expect(isRequest({ v: PROTOCOL_VERSION, type: 'nope', payload: {} })).toBe(false);
    expect(isRequest({ v: PROTOCOL_VERSION + 1, type: 'ping', payload: {} })).toBe(false);
  });

  it('routes the API-key write messages to their handlers', async () => {
    expect(await handleRequest(createRequest('set-api-key', { key: 'abc' }), handlers)).toEqual({
      ok: true,
      data: { apiKeyPresent: true, keyRevision: 3 },
    });
    expect(await handleRequest(createRequest('clear-api-key', {}), handlers)).toEqual({
      ok: true,
      data: { apiKeyPresent: false, keyRevision: 0 },
    });
  });

  it('accepts test-connection requests and echoes the attempt id', async () => {
    const request = createRequest('test-connection', { attemptId: 'a1' });
    expect(isRequest(request)).toBe(true);
    expect(await handleRequest(request, handlers)).toEqual({
      ok: true,
      data: { attemptId: 'a1', result: { status: 'no-key' } },
    });
  });

  it('routes a ping to its handler and wraps the result', async () => {
    const response = await handleRequest(createRequest('ping', {}), handlers);
    expect(response).toEqual({ ok: true, data: { pong: true, protocolVersion: PROTOCOL_VERSION } });
  });

  it('turns handler failures into error responses instead of throwing', async () => {
    const failing: Handlers = {
      ping: () => {
        throw new Error('boom');
      },
      'test-connection': handlers['test-connection'],
      'set-settings': handlers['set-settings'],
      'set-api-key': handlers['set-api-key'],
      'clear-api-key': handlers['clear-api-key'],
    };
    expect(await handleRequest(createRequest('ping', {}), failing)).toEqual({
      ok: false,
      error: 'boom',
    });
  });
});
