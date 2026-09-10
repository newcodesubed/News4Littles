/**
 * One background job at a time, across every kind of job.
 *
 * A scrape run's simplification phase and a manual simplify batch both turn raw
 * articles into kid articles, so allowing them to overlap risks two kid
 * articles for one raw. They are therefore mutually exclusive, not merely
 * "one scrape at a time" as the scrape service used to enforce on its own.
 *
 * Module-level, because the whole app is one process with one admin (§2.2). If
 * this ever runs as more than one instance, the lock has to move into the
 * database.
 */
import { ConflictError } from '../core/errors.js';

export type JobKind = 'scrape' | 'simplify' | 'regenerate';

const HOLDER: Record<JobKind, string> = {
  scrape: 'A scrape is already running',
  simplify: 'A simplification batch is already running',
  regenerate: 'A regeneration is already running',
};

const WANTED: Record<JobKind, string> = {
  scrape: 'starting another scrape',
  simplify: 'simplifying more articles',
  regenerate: 'regenerating a story',
};

let held: JobKind | null = null;

export function activeJob(): JobKind | null {
  return held;
}

/** Throws ConflictError (HTTP 409) naming whichever job holds the lock. */
export function acquireJob(kind: JobKind): void {
  if (held) {
    throw new ConflictError(`${HOLDER[held]}. Wait for it to finish before ${WANTED[kind]}.`);
  }
  held = kind;
}

/** Always call this from a `finally`, so a thrown job cannot leak the lock. */
export function releaseJob(): void {
  held = null;
}
