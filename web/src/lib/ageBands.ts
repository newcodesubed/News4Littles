/**
 * Reading bands — the unit a story is written in. Mirrors
 * server/src/core/article.ts, which is the source of truth; the two are kept
 * in step by hand because the projects share no package.
 *
 * A story is simplified once per BAND (5–7, 8–10, 11–14), not once per age,
 * and each version is stored under the band's youngest age — its ANCHOR. The
 * public slider still moves one year at a time; the API resolves the reader's
 * age to a band. Anywhere an editor picks WHICH version (submit, edit, prompt
 * overrides, the sandbox), the choice is a band.
 */
export interface AgeBand {
  /** The youngest age in the band; also its anchor — the stored ageTarget. */
  readonly minAge: number;
  readonly maxAge: number;
}

/** §3.6 reading-age range — what the public slider offers — and its default. */
export const MIN_AGE = 5;
export const MAX_AGE = 14;
export const DEFAULT_AGE = 6;

export const AGE_BANDS: readonly AgeBand[] = [
  { minAge: 5, maxAge: 7 },
  { minAge: 8, maxAge: 10 },
  { minAge: 11, maxAge: 14 },
];

/** The ageTarget values a stored version may carry: one per band. */
export const AGE_BAND_ANCHORS: readonly number[] = AGE_BANDS.map((band) => band.minAge);

/** True when `age` is a band's anchor — a value a stored ageTarget may hold. */
export function isAgeBandAnchor(age: number): boolean {
  return AGE_BAND_ANCHORS.includes(age);
}

/** The band a reader of `age` falls in; out-of-range ages clamp. */
export function bandForAge(age: number): AgeBand {
  return AGE_BANDS.find((band) => age <= band.maxAge) ?? AGE_BANDS[AGE_BANDS.length - 1]!;
}

/** "5–7" */
export function formatAgeBand(band: AgeBand): string {
  return `${band.minAge}–${band.maxAge}`;
}

/** "Ages 5–7", from a stored ageTarget (or any age in the band). */
export function ageBandLabel(ageTarget: number): string {
  return `Ages ${formatAgeBand(bandForAge(ageTarget))}`;
}
