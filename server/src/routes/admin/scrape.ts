/** Manual scraping — PRD §4.4 "Run now buttons (all sources / per source)". */
import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { createScrapeRunRepository } from '../../db/repositories/scrapeRunRepository.js';
import { getRunState, startScrapeRun, summarise } from '../../services/scrapeService.js';

export function createScrapeRouter(db: Database): Router {
  const router = Router();
  const runs = createScrapeRunRepository(db);

  /** Whatever the client needs to render progress or the finished result. */
  const stateResponse = () => {
    const state = getRunState();
    if (!state) return { running: false, run: null };
    return { running: state.running, run: { ...state, summary: summarise(state) } };
  };

  /** §4.4: the last result per source, so the page is useful before any click. */
  router.get('/scrape/status', (_req, res) => {
    res.json({ ...stateResponse(), lastRuns: runs.latestPerSource() });
  });

  router.get('/scrape/runs/:sourceId', (req, res) => {
    res.json(runs.listForSource(req.params.sourceId));
  });

  /** Every enabled source. Returns straight away; poll /scrape/status. */
  router.post('/scrape', (_req, res) => {
    startScrapeRun(db);
    res.status(202).json(stateResponse());
  });

  /** One source, named. Works even if it is disabled: the editor asked. */
  router.post('/scrape/:sourceId', (req, res) => {
    startScrapeRun(db, { sourceId: req.params.sourceId });
    res.status(202).json(stateResponse());
  });

  return router;
}
