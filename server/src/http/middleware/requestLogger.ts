/** Two lines per request, not one, so a hung request still leaves a `started` line. */
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Logger } from '../../logger.js';

declare module 'express-serve-static-core' {
  interface Request {
    id: string;
    log: Logger;
  }
}

export function createRequestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    req.id = randomUUID();
    req.log = logger.child({ reqId: req.id });
    res.setHeader('X-Request-Id', req.id);

    const startedAt = process.hrtime.bigint();
    const durationMs = () => Math.round(Number(process.hrtime.bigint() - startedAt) / 1e4) / 100;

    req.log.info({ method: req.method, url: req.originalUrl }, 'request started');

    res.on('finish', () => {
      req.log.info({ status: res.statusCode, durationMs: durationMs() }, 'request completed');
    });
    res.on('close', () => {
      if (!res.writableFinished) req.log.warn({ durationMs: durationMs() }, 'request aborted');
    });

    next();
  };
}
