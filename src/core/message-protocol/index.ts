/**
 * Versioned request/response contract between content scripts (and extension pages) and the
 * background. Add a new message by extending `MessageMap`; handlers and clients stay type-checked.
 */
import type { AnalysisTrigger, DraftSnapshot } from '@/core/draft-snapshot';
import type { PostSnapshot } from '@/core/post-snapshot';
import type { DraftAnalysisResult } from '@/core/analyzer';
import type { TargetAnalysisResult } from '@/core/target-analysis';
import type { OptimizationResult } from '@/core/optimizer';
import type { ConnectionTestResult } from '@/core/jev-client/connection-test';
import type { ApiKeyWriteResult, Settings, SettingsWriteResult } from '@/core/settings-store/types';

export const PROTOCOL_VERSION = 1;

export interface MessageMap {
  ping: {
    request: Record<string, never>;
    response: { pong: true; protocolVersion: number };
  };
  'test-connection': {
    /** Key typed in the Options field; when omitted the saved key is tested. */
    request: { attemptId: string; apiKey?: string };
    /** Echoes `attemptId` so the page can discard results from superseded attempts. */
    response: { attemptId: string; result: ConnectionTestResult };
  };
  /**
   * The ONLY settings write path for pages: the background is the extension's single writer, so
   * concurrent writes from independent contexts are serialized there and the revision is stamped
   * atomically with the settings in one storage write.
   */
  'set-settings': {
    /** Partial update; values are sanitized and clamped by the store before persisting. */
    request: { update: Partial<Settings> };
    /**
     * The persisted settings after the write, for immediate feedback in the requesting page, plus
     * the revision of the write: a page applies the snapshot only when strictly newer than the
     * last revision it applied, so a delayed older reply never repaints a newer state.
     */
    response: SettingsWriteResult;
  };
  /**
   * The ONLY API-key write paths for pages, mirroring `set-settings`: the background's single
   * writer serializes key writes and stamps the keyRevision atomically with the key change, so
   * the key-presence lane has an authoritative ordering token (docs/state-ordering.md lane (b)).
   */
  'set-api-key': {
    /** The new key, as typed; the store trims and validates it. */
    request: { key: string };
    /** The produced presence plus the write's keyRevision, for the page's gated apply. */
    response: ApiKeyWriteResult;
  };
  'clear-api-key': {
    request: Record<string, never>;
    response: ApiKeyWriteResult;
  };
  /**
   * A captured draft, sent by the content script's composer watcher (automatic debounced path or
   * the overlay's explicit "Analyze" action). The AnalyzerService scores it: the local heuristic
   * result always, the Jev verdict when enabled with a key, plus meta the overlay uses (headline,
   * status, draft hash). Honest refusals (`disabled`, `below-min-length`) carry no score and are
   * never recorded as analyses.
   */
  'analyze-draft': {
    request: { draft: DraftSnapshot; trigger: AnalysisTrigger };
    response: DraftAnalysisResult;
  };
  /**
   * A timeline post the user chose to deep-analyze from its target badge's popover ("Deep
   * analysis"). The TargetAnalysisService gates on settings (`unavailable` when `jevForTargets`
   * is off — the target path stays local, VAL-SETUP-012) and the Jev client serves the per-post
   * cache, so repeated activations cost zero further API calls (VAL-TARGET-020). Ordinary
   * timeline scanning NEVER sends this message.
   */
  'analyze-target': {
    request: { post: PostSnapshot };
    response: TargetAnalysisResult;
  };
  /**
   * The draft overlay's explicit "Optimize" action (m4-optimizer). The OptimizerService gates on
   * settings/key with honest typed refusals (`disabled` / `unavailable` / `no-key` — the overlay
   * renders the reason), and the JevClient's per-draft optimizer cache + in-flight coalescing
   * guarantee at most ONE api.typesafe.ai call per unique draft however often the user clicks
   * (VAL-OPT-009). Variants are presentation-only: the overlay copies them to the clipboard on
   * explicit user action and NEVER inserts them into the composer (VAL-OPT-005).
   */
  'optimize-draft': {
    request: { draft: DraftSnapshot };
    response: OptimizationResult;
  };
  /**
   * Opens the extension's Options page — content scripts cannot call `runtime.openOptionsPage`
   * themselves, so the overlay's "Connect Jev" prompt routes through the background.
   */
  'open-options-page': {
    request: Record<string, never>;
    response: { opened: true };
  };
  /**
   * Test-only seeding for the smoke harness (e2e builds — src/core/test-hooks.ts). The Firefox
   * harness cannot reach the background any other way: it relays this request through the content
   * script, and the background applies it through the REAL single-writer paths (settings, key)
   * plus the e2e Jev endpoint override. Direct `storage.local` writes from a content script are
   * NOT used: `storage.onChanged` is unreliable there (observed firing for only the first write
   * per document), while runtime messages are the proven lane. Production builds throw.
   */
  'seed-test-state': {
    request: {
      /** Full settings applied via `set-settings` (sanitized by the store). */
      settings?: Partial<Settings>;
      /** `''` clears the key; any other string is stored as the API key. */
      apiKey?: string;
      /** `''` clears the override; a URL redirects every Jev exchange (e2e builds only). */
      jevEndpointOverride?: string;
      /** When true, the background also calls `open-options-page` (used by the Firefox smoke
       * harness to exercise the Options page: Marionette cannot navigate to extension pages). */
      openOptionsPage?: boolean;
    };
    response: { seeded: true; settingsRevision: number; keyRevision: number };
  };
}

export type MessageType = keyof MessageMap;

export interface Request<T extends MessageType = MessageType> {
  v: typeof PROTOCOL_VERSION;
  type: T;
  payload: MessageMap[T]['request'];
}

export type Response<T extends MessageType = MessageType> =
  | { ok: true; data: MessageMap[T]['response'] }
  | { ok: false; error: string };

export type Handlers = {
  [T in MessageType]: (payload: MessageMap[T]['request']) => MessageMap[T]['response'] | Promise<MessageMap[T]['response']>;
};

const MESSAGE_TYPES: readonly string[] = [
  'ping',
  'test-connection',
  'set-settings',
  'set-api-key',
  'clear-api-key',
  'analyze-draft',
  'analyze-target',
  'optimize-draft',
  'open-options-page',
  'seed-test-state',
] satisfies MessageType[];

export function createRequest<T extends MessageType>(type: T, payload: MessageMap[T]['request']): Request<T> {
  return { v: PROTOCOL_VERSION, type, payload };
}

export function isRequest(value: unknown): value is Request {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.v === PROTOCOL_VERSION &&
    typeof candidate.type === 'string' &&
    MESSAGE_TYPES.includes(candidate.type) &&
    'payload' in candidate
  );
}

export async function handleRequest<T extends MessageType>(
  request: Request<T>,
  handlers: Handlers,
): Promise<Response<T>> {
  try {
    const handler = handlers[request.type] as (payload: Request<T>['payload']) => Promise<MessageMap[T]['response']> | MessageMap[T]['response'];
    return { ok: true, data: await handler(request.payload) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
