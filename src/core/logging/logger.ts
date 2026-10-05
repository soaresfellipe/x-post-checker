/**
 * The product logger: the ONLY sanctioned way for src/ code to emit a log line. Every argument
 * passes through the redaction engine (./redact) before the sink sees it, and the default level
 * keeps release builds silent below `warn` (config.ts). Nothing here is telemetry — the default
 * sink is the local console, and nothing is ever transmitted.
 *
 * The sink is injectable so tests (and the parity harness) can capture exactly what would have
 * been emitted, assertions included.
 */
import { DEFAULT_LOG_LEVEL, LOG_LEVELS, type LogLevel } from './config';
import { redactValue } from './redact';

/** Receives one already-redacted log record. Defaults to the console, routed by level. */
export type LogSink = (level: LogLevel, args: readonly unknown[]) => void;

export function createConsoleSink(): LogSink {
  return (level, args) => {
    // The one sanctioned console use in src/: every other surface must go through a logger so
    // its output is redacted first.
    (console[level === 'debug' ? 'log' : level] as (...args: unknown[]) => void)(...args);
  };
}

export interface LoggerDeps {
  /** Stable prefix for every line from this logger, usually the module name. */
  scope: string;
  /** Minimum level this logger emits; defaults to DEFAULT_LOG_LEVEL (warn). */
  level?: LogLevel;
  /** Where redacted records go; defaults to the console. */
  sink?: LogSink;
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** A logger for a submodule, inheriting this logger's level and sink. */
  child(subscope: string): Logger;
}

function levelRank(level: LogLevel): number {
  return LOG_LEVELS.indexOf(level);
}

/** Builds a redaction-first logger. Every argument is scrubbed; nothing is emitted below `level`. */
export function createLogger(deps: LoggerDeps): Logger {
  const sink = deps.sink ?? createConsoleSink();
  const minRank = levelRank(deps.level ?? DEFAULT_LOG_LEVEL);
  const prefix = `[${deps.scope}]`;

  const emit = (level: LogLevel, args: readonly unknown[]): void => {
    if (levelRank(level) < minRank) return;
    // The scope prefix is prepended AFTER redaction, so it can never be scrubbed away.
    sink(level, [prefix, ...args.map((arg) => redactValue(arg))]);
  };

  return {
    debug: (...args) => emit('debug', args),
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
    child: (subscope: string) => createLogger({ scope: `${deps.scope}:${subscope}`, level: deps.level, sink }),
  };
}
