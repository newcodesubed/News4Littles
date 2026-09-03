import { categoryStyle, SAFETY_LABELS, SAFETY_STYLES } from '../lib/format';
import type { Safety } from '../lib/types';

const BASE = 'inline-flex items-center rounded-full px-3 py-1 text-xs font-bold tracking-wide';

export function CategoryBadge({ category }: { category: string }) {
  return <span className={`${BASE} uppercase ${categoryStyle(category)}`}>{category}</span>;
}

/**
 * Renders NOTHING for 'calm' stories.
 *
 * PRD §3.3 lists calm as one of the badge values, but a badge on every card
 * makes the flag meaningless — the point is to draw the eye to the stories that
 * need a grown-up. Calm is the default state and is communicated by the absence
 * of a flag. Same rule as the feeling note (§3.4).
 */
export function SafetyBadge({ safety }: { safety: Safety }) {
  if (safety === 'calm') return null;

  return (
    <span className={`${BASE} ${SAFETY_STYLES[safety]}`}>
      <span aria-hidden="true" className="mr-1">
        {safety === 'skip-young' ? '★' : '☂'}
      </span>
      {SAFETY_LABELS[safety]}
    </span>
  );
}
