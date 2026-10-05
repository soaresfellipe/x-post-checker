/**
 * The redaction engine: every value a logger emits passes through here first, so a secret that
 * reaches a log call by accident (an error message quoting a URL, a settings object passed for
 * context) still lands on the console scrubbed. Two complementary passes:
 *
 * 1. `redactText` scrubs secret SHAPES inside free-form strings (Bearer tokens, session cookies,
 *    key-bearing query parameters, JSON secret fields) — this is what protects error messages
 *    and stacks, which are opaque strings the engine cannot key-match.
 * 2. `redactValue` walks structured values and drops fields whose KEY names a secret, then
 *    redactText-scrubs whatever strings remain.
 *
 * Deliberate limits: this is log scrubbing, not a general censor. It never sees user draft text
 * in normal operation (nothing logs drafts), and pattern matching cannot catch every encoding —
 * the first line of defense remains not passing secrets to loggers at all.
 */
import { REDACTION_CONFIG, SENSITIVE_KEY_PATTERN } from './config';

/** The exact token every redacted value collapses to. */
export const REDACTED = REDACTION_CONFIG.placeholder;

/**
 * Secret shapes scrubbed from any emitted string. Each pattern replaces only the secret part so
 * the surrounding log context (the label, the host, the error text) stays readable. Ordered:
 * earlier, more specific patterns run first.
 */
const SECRET_PATTERNS: readonly { pattern: RegExp; replacement: string }[] = Object.freeze([
  // "Authorization: Bearer <token>" and bare "Bearer <token>" (the Jev wire shape).
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: `Bearer ${REDACTED}` },
  // Any other credentialed Authorization header ("Authorization: Basic ...", "authorization=...").
  {
    pattern: /\bauthorization\b\s*[:=]\s*["']?[A-Za-z]+\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: `Authorization: ${REDACTED}`,
  },
  // Set-Cookie / Cookie header values: the whole header line, every pair on it.
  { pattern: /\b(?:set-)?cookie\b\s*[:=]\s*["']?[^"'\n]+/gi, replacement: `cookie: ${REDACTED}` },
  // The known X session cookies and generic id/session cookies in `name=value` shape.
  { pattern: /\b(auth_token|ct0|sid|session)\b=([^\s;"'&]+)/gi, replacement: `$1=${REDACTED}` },
  // Secret-bearing query parameters on any URL.
  {
    pattern: /\b(access_token|api[-_]?key|apikey|auth[-_]?token|token|sig(?:nature)?)=([^\s&"']+)/gi,
    replacement: `$1=${REDACTED}`,
  },
  // JSON-shaped secret fields ("apiKey": "..."), quoted or not.
  {
    pattern: /(["']?[A-Za-z0-9_-]*(?:api[-_]?key|auth[-_]?token|authorization|password|secret|token|cookie|ct0)[A-Za-z0-9_-]*["']?\s*[:=]\s*)(["'])[^"'\n]*\2/gi,
    replacement: `$1${REDACTED}`,
  },
  // Basic-auth credentials embedded in a URL (https://user:pass@host).
  { pattern: /(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/g, replacement: `$1${REDACTED}@` },
]);

/**
 * Maximum entries emitted per array/object before an ellipsis marker replaces the rest, so a
 * huge payload passed for context can never blow up a log line. Read from the config once.
 */
const MAX_ENTRIES = REDACTION_CONFIG.maxEntries;

/** Scrubs every known secret shape out of a free-form string and truncates it to a sane length. */
export function redactText(text: string): string {
  let scrubbed = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, replacement);
  }
  return scrubbed.length > REDACTION_CONFIG.maxStringLength
    ? `${scrubbed.slice(0, REDACTION_CONFIG.maxStringLength)}…(truncated)`
    : scrubbed;
}

/**
 * Deep redaction of a structured value: secret-named keys collapse to the placeholder, every
 * remaining string is pattern-scrubbed, and the walk is depth- and size-capped. Pure: the input
 * is never mutated, so a caller can safely log an object it still uses.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > REDACTION_CONFIG.maxDepth) return REDACTED;

  if (typeof value === 'string') return redactText(value);
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null ||
    value === undefined
  ) {
    return value;
  }

  if (value instanceof Error) {
    // Errors are scrubbed as text (message/stack can quote URLs with tokens); the name is fixed
    // vocabulary. A redacted copy is returned so the original Error is untouched.
    return {
      name: value.name,
      message: redactText(value.message),
      stack: value.stack === undefined ? undefined : redactText(value.stack),
    };
  }

  if (Array.isArray(value)) {
    const entries = value.slice(0, MAX_ENTRIES).map((entry) => redactValue(entry, depth + 1));
    if (value.length > MAX_ENTRIES) entries.push(`…(${value.length - MAX_ENTRIES} more)`);
    return entries;
  }

  if (value instanceof Map) {
    // Keys get the same sensitive-name treatment as object keys: convert, then redact normally.
    const entries: Record<string, unknown> = {};
    for (const [key, entry] of value.entries()) entries[String(key)] = entry;
    return redactValue(entries, depth + 1);
  }
  if (value instanceof Set) {
    return redactValue([...value.values()], depth + 1);
  }

  if (typeof value === 'object') {
    const plain = value as Record<string, unknown>;
    const scrubbed: Record<string, unknown> = {};
    const keys = Object.keys(plain).slice(0, MAX_ENTRIES);
    for (const key of keys) {
      scrubbed[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? REDACTED
        : redactValue(plain[key], depth + 1);
    }
    const total = Object.keys(plain).length;
    if (total > MAX_ENTRIES) scrubbed[`…(${total - MAX_ENTRIES} more)`] = '';
    return scrubbed;
  }

  // Functions and symbols have no place in a log line; emit stable vocabulary, not source text.
  return typeof value === 'function' ? '[function]' : String(value);
}

/** One-line scrubbed text for an unknown thrown value, safe for a response envelope or a log. */
export function redactError(error: unknown): string {
  if (error instanceof Error) return redactText(`${error.name}: ${error.message}`);
  return redactText(String(error));
}
