/**
 * How a scrape run decides which articles get the LLM budget.
 *
 * Pure function, so these are plain unit tests: no database, no feed, no model.
 */
import { describe, expect, it } from 'vitest';
import { selectBudgetedBatch, type SourceQueue } from '../src/services/simplifyBudget.js';

/** n waiting ids for one source, newest first, named so order is visible. */
const queue = (sourceId: string, n: number): SourceQueue => ({
  sourceId,
  rawIds: Array.from({ length: n }, (_, i) => `${sourceId}-${i + 1}`),
});

const countsBySource = (picked: string[]) => {
  const counts: Record<string, number> = {};
  for (const id of picked) {
    const source = id.slice(0, id.lastIndexOf('-'));
    counts[source] = (counts[source] ?? 0) + 1;
  }
  return counts;
};

describe('selectBudgetedBatch', () => {
  it('spreads the budget across sources instead of letting one feed take it all', () => {
    const picked = selectBudgetedBatch(
      [queue('bbc', 20), queue('reuters', 20), queue('ap', 20), queue('npr', 20)],
      10,
    );

    expect(picked).toHaveLength(10);
    expect(countsBySource(picked)).toEqual({ bbc: 3, reuters: 3, ap: 2, npr: 2 });
  });

  it('takes the newest first within each source', () => {
    // Each queue arrives newest-first, so the first pick from each is its newest.
    const picked = selectBudgetedBatch([queue('bbc', 3), queue('npr', 3)], 4);
    expect(picked).toEqual(['bbc-1', 'npr-1', 'bbc-2', 'npr-2']);
  });

  it('lets a thin source hand its unused share to the others', () => {
    // The whole point of round-robin over pre-allocation: a source with one
    // candidate takes one, and the budget is still fully spent.
    const picked = selectBudgetedBatch([queue('bbc', 1), queue('npr', 20)], 10);

    expect(picked).toHaveLength(10);
    expect(countsBySource(picked)).toEqual({ bbc: 1, npr: 9 });
  });

  it('spends nothing when the budget is 0', () => {
    expect(selectBudgetedBatch([queue('bbc', 20)], 0)).toEqual([]);
  });

  it('treats a negative budget as 0 rather than looping', () => {
    expect(selectBudgetedBatch([queue('bbc', 20)], -5)).toEqual([]);
  });

  it('takes everything when the budget exceeds the backlog', () => {
    const picked = selectBudgetedBatch([queue('bbc', 2), queue('npr', 1)], 10);
    expect([...picked].sort()).toEqual(['bbc-1', 'bbc-2', 'npr-1']);
  });

  it('is a plain take-the-first-N for a single source', () => {
    expect(selectBudgetedBatch([queue('bbc', 5)], 3)).toEqual(['bbc-1', 'bbc-2', 'bbc-3']);
  });

  it('returns nothing when there is nothing waiting', () => {
    expect(selectBudgetedBatch([], 10)).toEqual([]);
    expect(selectBudgetedBatch([queue('bbc', 0)], 10)).toEqual([]);
  });
});
