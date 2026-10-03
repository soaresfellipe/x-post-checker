/**
 * The background's request handlers. Kept out of the entrypoint so they are unit-testable with an
 * injected store/transport while the entrypoint only wires them to the real browser APIs.
 */
import { isDraftSnapshot, type AnalysisTrigger } from '@/core/draft-snapshot';
import { isPostSnapshot } from '@/core/post-snapshot';
import { runConnectionTest } from '@/core/jev-client';
import type { AnalyzerService } from '@/core/analyzer';
import type { TargetAnalysisService } from '@/core/target-analysis';
import type { OptimizerService } from '@/core/optimizer';
import type { SettingsStore } from '@/core/settings-store';
import type { MessageMap } from './index';
import { PROTOCOL_VERSION, type Handlers } from './index';

/** The slice of the connection-test runner the handler depends on (injectable for tests). */
export type ConnectionTester = typeof runConnectionTest;

export interface BackgroundHandlerDeps {
  /**
   * Must be the background's own store instance: the background is the extension's SINGLE settings
   * writer, so every `set-settings` request is serialized (and its revision stamped) through it.
   */
  store: SettingsStore;
  runConnectionTest?: ConnectionTester;
  /** The analysis pipeline (heuristic engine + Jev client); injectable for unit tests. */
  analyzer: AnalyzerService;
  /** The deep-analysis pipeline for timeline targets ("Deep analysis"); injectable for tests. */
  targetAnalyzer: TargetAnalysisService;
  /** The draft-optimization pipeline ("Optimize"); injectable for unit tests. */
  optimizer: OptimizerService;
  /**
   * Opens the Options page (`browser.runtime.openOptionsPage`); injectable for unit tests. The
   * background always wires it; when absent the handler answers with an explicit protocol error
   * instead of pretending the page opened.
   */
  openOptionsPage?: () => Promise<void>;
  /**
   * Test-only seeder (e2e builds only — src/core/test-hooks.ts): applies the smoke harness's
   * seed through the real single-writer store paths and persists the Jev endpoint override.
   * Wired only in e2e builds; when absent the handler refuses (release builds never seed).
   */
  seedTestState?: (payload: MessageMap['seed-test-state']['request']) => Promise<MessageMap['seed-test-state']['response']>;
}

const TRIGGERS: readonly AnalysisTrigger[] = ['auto', 'manual'];

export function createBackgroundHandlers(deps: BackgroundHandlerDeps): Handlers {
  const { store, analyzer, targetAnalyzer, optimizer } = deps;
  const testConnection = deps.runConnectionTest ?? runConnectionTest;
  return {
    ping: () => ({ pong: true, protocolVersion: PROTOCOL_VERSION }),
    'test-connection': async ({ attemptId, apiKey }) => {
      const typedKey = apiKey?.trim();
      const key = typedKey ? typedKey : await store.getApiKey();
      return { attemptId, result: await testConnection({ apiKey: key }) };
    },
    'set-settings': async ({ update }) => {
      // Reject non-object payloads outright; the store sanitizes everything else (unknown keys and
      // malformed values are dropped, numbers clamped) so a page can never persist garbage. The
      // reply carries the write's revision so the requesting page can order it against
      // storage-driven updates (strictly-newer gate) instead of repainting stale state.
      if (typeof update !== 'object' || update === null) throw new Error('Invalid settings update.');
      return store.setSettings(update);
    },
    // Key writes are serialized through the same single writer, so the stamped keyRevision is a
    // total order over all key writes; the reply lets the requesting page gate its own
    // save/remove feedback through the key lane's strictly-newer gate.
    'set-api-key': async ({ key }) => {
      if (typeof key !== 'string') throw new Error('Invalid API key.');
      return store.setApiKey(key);
    },
    'clear-api-key': () => store.clearApiKey(),
    // The message payload is untrusted input: a snapshot must pass the runtime guard before the
    // analyzer touches it. Invalid input is a protocol error (the caller sees {ok:false}); every
    // VALID draft gets a typed analysis result, never a throw.
    'analyze-draft': ({ draft, trigger }) => {
      if (!isDraftSnapshot(draft)) throw new Error('Invalid draft snapshot.');
      if (!TRIGGERS.includes(trigger)) throw new Error('Invalid analysis trigger.');
      return analyzer.analyzeDraft(draft, trigger);
    },
    // Same untrusted-input rule for deep analysis: an invalid PostSnapshot is a protocol error;
    // a valid one gets a typed result (analyzed / unavailable / no-key / error), never a throw.
    'analyze-target': ({ post }) => {
      if (!isPostSnapshot(post)) throw new Error('Invalid post snapshot.');
      return targetAnalyzer.analyzeTarget(post);
    },
    // Same untrusted-input rule for the optimizer: an invalid DraftSnapshot is a protocol error;
    // a valid one gets a typed result (optimized / disabled / unavailable / no-key / error).
    'optimize-draft': ({ draft }) => {
      if (!isDraftSnapshot(draft)) throw new Error('Invalid draft snapshot.');
      return optimizer.optimizeDraft(draft);
    },
    // Content scripts cannot call runtime.openOptionsPage (extension pages only), so the overlay's
    // "Connect Jev" prompt asks the background to open it.
    'open-options-page': async () => {
      if (!deps.openOptionsPage) throw new Error('Options page opening is not available.');
      await deps.openOptionsPage();
      return { opened: true };
    },
    // Test-only (e2e builds): the smoke harness's settings/key/endpoint seed, applied through the
    // REAL single-writer paths. Release builds refuse: no test seeding ships.
    'seed-test-state': async (payload) => {
      if (!deps.seedTestState) throw new Error('seed-test-state is only available in e2e builds.');
      return deps.seedTestState(payload);
    },
  };
}
