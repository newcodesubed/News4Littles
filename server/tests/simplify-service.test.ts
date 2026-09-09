/**
 * On-demand simplification and the one-job-at-a-time rule.
 *
 * The lock is not tidiness: a scrape's simplification phase and a manual batch
 * both write kid_articles for raw rows, so running them together could write
 * two kid articles for one raw article.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { acquireJob, activeJob, releaseJob } from '../src/services/jobLock.js';

describe('jobLock', () => {
  beforeEach(() => releaseJob());

  it('is free to begin with', () => {
    expect(activeJob()).toBeNull();
  });

  it('refuses a second job while one is held, naming the holder', () => {
    acquireJob('scrape');
    expect(activeJob()).toBe('scrape');
    expect(() => acquireJob('simplify')).toThrow(/scrape is already running/);
  });

  it('refuses a scrape while a simplification batch is running', () => {
    acquireJob('simplify');
    expect(() => acquireJob('scrape')).toThrow(/simplification batch is already running/);
  });

  it('can be taken again after release', () => {
    acquireJob('simplify');
    releaseJob();
    expect(activeJob()).toBeNull();
    expect(() => acquireJob('scrape')).not.toThrow();
  });
});
