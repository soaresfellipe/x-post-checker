/**
 * The one place every logging and redaction tuning constant lives (AGENTS.md: "one config module
 * per concern; no magic numbers"). The redaction rules themselves are in ./redact; this module
 * only holds the level policy and the redaction limits the rules read.
 */

/** Severity ladder, ordered: a logger configured at `warn` emits warn and error only. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error'] as const);

/**
 * Release default. The extension ships zero telemetry (AGENTS.md: no new hosts, no telemetry), so
 * logs exist solely for local debugging in the browser console; `warn` keeps normal operation
 * silent while surfacing failures. Call sites that truly need debug noise opt a logger into a
 * lower level explicitly.
 */
export const DEFAULT_LOG_LEVEL: LogLevel = 'warn';

/** Caps and the placeholder used by the redaction engine (./redact). */
export const REDACTION_CONFIG = Object.freeze({
  /** Every redacted value collapses to exactly this token. */
  placeholder: '[REDACTED]',
  /** Maximum walk depth for nested structures; deeper values collapse to the placeholder. */
  maxDepth: 8,
  /** Scrubbed strings longer than this are truncated so a log line can never be unbounded. */
  maxStringLength: 4_000,
  /** Maximum array entries / object keys emitted per container before an ellipsis marker. */
  maxEntries: 100,
});

/**
 * Field names that always mark a value as a secret, matched case-insensitively against object
 * keys (and only keys — plain strings go through pattern scrubbing instead). Deliberately
 * includes the X session cookies (`auth_token`, `ct0`) the real-x harness treats as credential
 * material, and the Jev key field names used across the settings and client layers.
 */
export const SENSITIVE_KEY_PATTERN: RegExp =
  /api[-_]?key|auth[-_]?token|authorization|^auth$|bearer|cookie|credentials?|ct0|passwd|password|secret|session/i;
