import type { Database } from 'better-sqlite3';
import { MAX_AGE, MIN_AGE, bandForAge } from '../../core/article.js';
import { createSettingsRepository } from '../../db/repositories/settingsRepository.js';

/**
 * The anchor of the band the reader's age falls in — the ageTarget their
 * version is stored under. Falls back to the configured default age.
 *
 * An absent, non-numeric or out-of-range value falls back rather than
 * erroring: this is the read path a child's browser hits, and answering with
 * the default beats a 400 because a query string was odd. Bound as a
 * parameter by the repository, never interpolated.
 */
export function createAgeTargetReader(db: Database): (raw: unknown) => number {
  const settings = createSettingsRepository(db);

  return (raw) => {
    const age = Number(raw);
    const usable = Number.isInteger(age) && age >= MIN_AGE && age <= MAX_AGE;
    return bandForAge(usable ? age : settings.getAppSettings().defaultAge).minAge;
  };
}
