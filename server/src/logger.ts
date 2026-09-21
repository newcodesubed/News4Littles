/**
 * The one logger the server writes through.
 *
 * Every line goes to a rolling JSON file; in development it also goes to the
 * terminal, pretty-printed. Request-scoped logging lives in
 * http/middleware/requestLogger.ts; anything with no request in scope takes a
 * child logger named by area:  logger.child({ area: 'scrape' })
 */
import pino, { type Logger, type TransportTargetOptions } from 'pino';
import { join } from 'node:path';
import { LOG_DIR, LOG_LEVEL, LOG_PRETTY } from './env.js';

export type { Logger };

/** A new file every 5 MB, the newest ten kept — the directory stays under ~50 MB. */
const fileTarget: TransportTargetOptions = {
  target: 'pino-roll',
  options: {
    file: join(LOG_DIR, 'server'),
    extension: '.log',
    size: '5m',
    limit: { count: 10 },
    mkdir: true,
  },
};

const stdoutTarget: TransportTargetOptions = LOG_PRETTY
  ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
  : { target: 'pino/file', options: { destination: 1 } };

export function createLogger(): Logger {
  // Transports run in a worker thread; `silent` skips spawning one at all.
  if (LOG_LEVEL === 'silent') return pino({ level: 'silent' });

  return pino({
    level: LOG_LEVEL,
    // Admin uses Basic Auth, so without this the credentials land on disk.
    redact: ['req.headers.authorization'],
    transport: { targets: [fileTarget, stdoutTarget] },
  });
}

export const logger = createLogger();
