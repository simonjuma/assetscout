/**
 * Structured ingestion logging.
 *
 * Every emitted value is passed through `redactSecrets`, so a provider response
 * (or an auth header echoed back by an upstream error) cannot smuggle a
 * credential into the platform log stream.
 *
 * No I/O, no globals: the sink is injectable, which is what lets the test suite
 * assert on log output.
 */
import { redactSecrets } from '../errors.ts';
import type { IngestLogger } from './types.ts';

export type LogLevel = 'info' | 'warn' | 'error';

export type LogSink = {
  info(message: string, meta: Record<string, unknown>): void;
  warn(message: string, meta: Record<string, unknown>): void;
  error(message: string, meta: Record<string, unknown>): void;
};

const consoleSink: LogSink = {
  info: (message, meta) => console.log(message, meta),
  warn: (message, meta) => console.warn(message, meta),
  error: (message, meta) => console.error(message, meta),
};

/** Recursively redacts strings and caps depth so a log line stays small. */
function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSecrets(value, 300);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return redactSecrets(value.message, 300);
  if (depth >= 3) return '[depth-limit]';
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      out[key] = sanitize(item, depth + 1);
    }
    return out;
  }
  return '[unloggable]';
}

export function createLogger(
  scope: string,
  correlationId: string,
  sink: LogSink = consoleSink,
): IngestLogger {
  const emit = (level: LogLevel, event: string, data?: Record<string, unknown>) => {
    const meta = { correlationId, ...(sanitize(data ?? {}) as Record<string, unknown>) };
    sink[level](`[ingest:${scope}] ${event}`, meta);
  };

  return {
    info: (event, data) => emit('info', event, data),
    warn: (event, data) => emit('warn', event, data),
    error: (event, data) => emit('error', event, data),
    child: (childScope) => createLogger(`${scope}:${childScope}`, correlationId, sink),
  };
}

/** Discards all output. Used by tests that assert on data, not logs. */
export function createSilentLogger(): IngestLogger {
  const noop = () => undefined;
  const silent: LogSink = { info: noop, warn: noop, error: noop };
  return {
    info: noop,
    warn: noop,
    error: noop,
    child: () => createLogger('silent', 'silent', silent),
  };
}

/** Captures log lines for assertions. */
export function createCapturingLogger(): { logger: IngestLogger; lines: Array<{ level: LogLevel; message: string; meta: Record<string, unknown> }> } {
  const lines: Array<{ level: LogLevel; message: string; meta: Record<string, unknown> }> = [];
  const record =
    (level: LogLevel): ((message: string, meta: Record<string, unknown>) => void) =>
    (message, meta) => {
      lines.push({ level, message, meta });
    };

  const logger = createLogger('test', 'test-correlation', {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  });

  return { logger, lines };
}