/**
 * Central error handling — the last middleware in the stack.
 *
 * Before this existed, an unexpected throw fell through to Express's default
 * handler, which replies with an HTML page containing a stack trace. That
 * leaked file paths to the client and broke the frontend, which always parses
 * error bodies as JSON.
 */
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from '../../core/errors.js';

/** Anything that reached the end of the stack without matching a route. */
export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: 'Not found.' });
};

/** Body-parser marks its own failures with `type: 'entity.parse.failed'`. */
function isJsonParseError(error: unknown): boolean {
  return (
    error instanceof SyntaxError &&
    'type' in error &&
    (error as { type?: string }).type === 'entity.parse.failed'
  );
}

export const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  // A partially sent response cannot be rewritten; hand it back to Express.
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof AppError) {
    res.status(error.status).json({ error: error.message });
    return;
  }

  if (isJsonParseError(error)) {
    res.status(400).json({ error: 'Request body is not valid JSON.' });
    return;
  }

  // Genuinely unexpected: log it in full for the operator, tell the client
  // nothing that would help an attacker.
  console.error('[error] unhandled:', error);
  res.status(500).json({ error: 'Something went wrong on the server.' });
};
