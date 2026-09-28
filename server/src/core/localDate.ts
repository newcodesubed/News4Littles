/**
 * The calendar date an instant falls on in a given zone, as YYYY-MM-DD.
 *
 * 'en-CA' formats dates ISO-style, so the result sorts and compares as a plain
 * string. Asking Intl for the local date, rather than doing offset arithmetic,
 * keeps it right across DST changes with no date library.
 */
export function localDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}
