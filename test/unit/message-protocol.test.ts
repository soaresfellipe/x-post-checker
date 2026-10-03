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
  'set-settings': ({ update }) => ({ settings: { ...DEFAULT_SETTINGS, ...update } }),
};

describe('message protocol', () => {
  it('builds versioned request envelopes', () => {
    expect(createRequest('ping', {})).toEqual({ v: PROTOCOL_VERSION, type: 'ping', payload: {} });
  });

  it('recognizes well-formed requests only', () => {
    expect(isRequest(createRequest('ping', {}))).toBe(true);
    expect(isRequest(null)).toBe(false);
    expect(isRequest({ type: 'ping' })).toBe(false);
    expect(isRequest({ v: PROTOCOL_VERSION, type: 'nope', payload: {} })).toBe(false);
    expect(isRequest({ v: PROTOCOL_VERSION + 1, type: 'ping', payload: {} })).toBe(false);
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
    };
    expect(await handleRequest(createRequest('ping', {}), failing)).toEqual({
      ok: false,
      error: 'boom',
    });
  });
});
