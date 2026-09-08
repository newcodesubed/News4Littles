/**
 * The one error vocabulary the whole server speaks.
 *
 * Anything thrown from a route, repository or service that derives from
 * AppError becomes a clean JSON response with the right status code, handled
 * once in http/middleware/errorHandler.ts. Nothing else needs a try/catch.
 */
export abstract class AppError extends Error {
  abstract readonly status: number;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** 400 — the request is malformed or fails validation. */
export class BadRequestError extends AppError {
  readonly status = 400;
}

/** 401 — no valid admin credentials. */
export class UnauthorizedError extends AppError {
  readonly status = 401;
}

/** 404 — the addressed resource does not exist. */
export class NotFoundError extends AppError {
  readonly status = 404;

  /** `notFound('article', id)` -> "No article with id 'abc'." */
  static of(resource: string, id: string): NotFoundError {
    return new NotFoundError(`No ${resource} with id '${id}'.`);
  }
}

/** 409 — the request is well-formed but conflicts with current state. */
export class ConflictError extends AppError {
  readonly status = 409;
}
