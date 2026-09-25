/** The one logger the server writes through; see README "Logging". */
import pino, { type Logger, type TransportTargetOptions } from 'pino';
import { createRequire } from 'node:module';
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

const jsonStdout: TransportTargetOptions = { target: 'pino/file', options: { destination: 1 } };

const require = createRequire(import.meta.url);

/** Whether pino-pretty can be loaded from here. */
function prettyInstalled(): boolean {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

/**
 * Pretty terminal output when it is asked for AND available. pino-pretty is a
 * dev dependency, so a production install (`npm ci --omit=dev`) lacks it, and
 * pino throws "unable to determine transport target" at start-up for a target
 * it cannot find. LOG_PRETTY defaults to true, so without this check the
 * default configuration could not start on a production install.
 */
export function chooseStdoutTarget(
  pretty: boolean,
  isPrettyInstalled: () => boolean = prettyInstalled,
): { target: TransportTargetOptions; prettyUnavailable: boolean } {
  if (!pretty) return { target: jsonStdout, prettyUnavailable: false };
  if (!isPrettyInstalled()) return { target: jsonStdout, prettyUnavailable: true };
  return {
    target: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } },
    prettyUnavailable: false,
  };
}

export function createLogger(): Logger {
  // `silent` never writes, so skip spawning the transport worker.
  if (LOG_LEVEL === 'silent') return pino({ level: 'silent' });

  const stdout = chooseStdoutTarget(LOG_PRETTY);
  const logger = pino({
    level: LOG_LEVEL,
    // Basic Auth credentials must never reach the log file.
    redact: ['req.headers.authorization'],
    transport: { targets: [fileTarget, stdout.target] },
  });

  if (stdout.prettyUnavailable) {
    logger.warn('LOG_PRETTY is true but pino-pretty is not installed; logging JSON to stdout instead');
  }
  return logger;
}

export const logger = createLogger();
