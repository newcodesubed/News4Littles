/**
 * Choosing which raw articles a scrape run spends its LLM budget on.
 *
 * PRD §5.2 runs steps 4-7 over every item, which is 40-50 model calls across
 * four feeds for a queue an editor triages ten of. This caps the spend.
 *
 * Round-robin rather than "the first N overall", so one busy feed cannot use
 * the whole budget and leave the others unrepresented in the queue. A source
 * with fewer candidates than its notional share simply runs dry and the
 * remainder flows to the others — which is why this beats pre-allocating
 * budget/n per source, where a thin feed wastes its share.
 *
 * Pure by design: no database, no clock, no model. The allocation rule is the
 * part worth testing exhaustively, and this keeps it cheap to do so.
 */

export interface SourceQueue {
  sourceId: string;
  /** Waiting raw article ids, newest first. */
  rawIds: string[];
}

export function selectBudgetedBatch(queues: SourceQueue[], budget: number): string[] {
  if (budget <= 0) return [];

  const picked: string[] = [];
  const taken = queues.map(() => 0);

  // Keep going round while at least one queue still had something to give.
  let progressed = true;
  while (picked.length < budget && progressed) {
    progressed = false;

    for (let i = 0; i < queues.length && picked.length < budget; i += 1) {
      const { rawIds } = queues[i];
      if (taken[i] >= rawIds.length) continue;

      picked.push(rawIds[taken[i]]);
      taken[i] += 1;
      progressed = true;
    }
  }

  return picked;
}
