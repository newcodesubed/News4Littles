/**
 * HTTP Basic Auth for /api/admin/* — PRD §4.1, §8.7, §10.
 *
 * Credentials are verified against the admin_users table, which stores only a
 * bcrypt hash (§8.7). The plaintext password exists in exactly one place: the
 * operator's .env, read by the seed when it creates the row. Nothing in this
 * file, or anywhere else in the codebase, contains a plaintext credential.
 *
 * §2.2 rules out multi-user roles, so a single shared account is correct here.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Database } from 'better-sqlite3';
import type { NextFunction, Request, Response } from 'express';

const REALM = 'News4Littles Admin';

/**
 * bcrypt is deliberately slow (~100ms at cost 10). The review queue fires
 * several requests per page, so a verified credential is remembered briefly to
 * avoid re-hashing on every call.
 *
 * Safe because the cache key is derived from the credential itself: a wrong
 * password can never collide onto a cached entry. Cleared on restart.
 */
const VERIFIED_TTL_MS = 5 * 60 * 1000;
const verified = new Map<string, number>();

function cacheKey(header: string): string {
  return createHash('sha256').update(header).digest('hex');
}

function unauthorized(res: Response, message: string): void {
  // The header is what makes a browser show its own login prompt.
  res.setHeader('WWW-Authenticate', `Basic realm="${REALM}", charset="UTF-8"`);
  res.status(401).json({ error: message });
}

/** Constant-time string compare, for the username. */
function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

export function createAdminAuth(db: Database) {
  const findUser = db.prepare(`SELECT username, passwordHash FROM admin_users WHERE username = ?`);

  return function adminAuth(req: Request, res: Response, next: NextFunction): void {
    const header = req.headers.authorization;

    if (!header || !header.startsWith('Basic ')) {
      unauthorized(res, 'Admin authentication required.');
      return;
    }

    const key = cacheKey(header);
    const cachedUntil = verified.get(key);
    if (cachedUntil !== undefined) {
      if (cachedUntil > Date.now()) {
        next();
        return;
      }
      verified.delete(key);
    }

    let decoded: string;
    try {
      decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
    } catch {
      unauthorized(res, 'Malformed authorization header.');
      return;
    }

    // Only the FIRST colon separates the pair; a password may contain colons.
    const separator = decoded.indexOf(':');
    if (separator === -1) {
      unauthorized(res, 'Malformed credentials.');
      return;
    }

    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);

    const row = findUser.get(username) as { username: string; passwordHash: string } | undefined;

    // Compare against a dummy hash when the user is unknown, so a bad username
    // and a bad password take the same time to reject.
    const hash = row?.passwordHash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
    const passwordOk = bcrypt.compareSync(password, hash);

    if (!row || !safeEqual(username, row.username) || !passwordOk) {
      unauthorized(res, 'Invalid admin credentials.');
      return;
    }

    verified.set(key, Date.now() + VERIFIED_TTL_MS);
    next();
  };
}
