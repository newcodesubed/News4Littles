/**
 * The reading band a public request is for, from its `?age=N`.
 *
 * Returns the anchor of the band N falls in — the ageTarget that band's
 * version is stored under — falling back to the configured default age. An
 * absent, non-numeric or out-of-range value falls back rather than erroring:
 * this is the read path a child's browser hits, and answering with the default
 * beats a 400 because a query string was odd.
 */
import type { Database } from 'better-sqlite3';
import { MAX_AGE, MIN_AGE, bandForAge } from '../../core/article.js';
import { createSettingsRepository } from '../../db/repositories/settingsRepository.js';

export function createAgeTargetReader(db: Database): (raw: unknown) => number {
  const settings = createSettingsRepository(db);

  return (raw) => {
    const age = Number(raw);
    const usable = Number.isInteger(age) && age >= MIN_AGE && age <= MAX_AGE;
    return bandForAge(usable ? age : settings.getAppSettings().defaultAge).minAge;
  };
}
