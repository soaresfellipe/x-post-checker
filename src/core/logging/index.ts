/**
 * Logging public surface. Product code logs ONLY through createLogger; the redaction helpers are
 * exported for call sites that build strings before logging (or that scrub test evidence).
 */
export { redactText, redactValue, redactError, REDACTED } from './redact';
export { createLogger, createConsoleSink, type Logger, type LogSink, type LoggerDeps } from './logger';
export { DEFAULT_LOG_LEVEL, LOG_LEVELS, REDACTION_CONFIG, SENSITIVE_KEY_PATTERN, type LogLevel } from './config';
