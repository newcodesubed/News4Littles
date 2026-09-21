/** The one logger the server writes through; see README "Logging". */
import pino, { type Logger, type TransportTargetOptions } from 'pino';
import { join } from 'node:path';
import { LOG_DIR, LOG_LEVEL, LOG_PRETTY } from './env.js';

export type { Logger };

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
  // `silent` never writes, so skip spawning the transport worker.
  if (LOG_LEVEL === 'silent') return pino({ level: 'silent' });

  return pino({
    level: LOG_LEVEL,
    // Basic Auth credentials must never reach the log file.
    redact: ['req.headers.authorization'],
    transport: { targets: [fileTarget, stdoutTarget] },
  });
}

export const logger = createLogger();
