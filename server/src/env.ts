/**
 * Every environment variable the server reads, in one place.
 *
 * Values come from server/.env (see .env.example for the documented list).
 * Real shell variables always win over the file, so a one-off override still
 * works:  PORT=5000 npm run dev
 *
 * Import config from here rather than touching process.env elsewhere — that
 * keeps defaults, parsing and validation in a single module.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

/** Repo path: /server */
export const SERVER_ROOT = fileURLToPath(new URL('..', import.meta.url));

// Loaded at import time, before any other module reads process.env.
config({ path: resolve(SERVER_ROOT, '.env'), quiet: true });

function readString(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got '${raw}'.`);
  }
  return value;
}

function readList(name: string, fallback: string[]): string[] {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const values = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (values.length === 0) {
    throw new Error(`${name} was set but contained no values.`);
  }
  return values;
}

/** Port the API listens on. */
export const PORT = readInt('PORT', 4000);

/** Origins allowed to call the API. The default is the Vite dev server. */
export const CORS_ORIGINS = readList('CORS_ORIGIN', [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

/** SQLite file. A relative value resolves against /server, not the shell's cwd. */
export const DATABASE_PATH = resolve(SERVER_ROOT, readString('DATABASE_PATH', 'data/news4littles.db'));

/** Admin credentials, used by the seed to create the account (PRD §4.1). */
export const ADMIN_USERNAME = readString('ADMIN_USERNAME', 'admin');
export const ADMIN_PASSWORD = readString('ADMIN_PASSWORD', 'admin123');
