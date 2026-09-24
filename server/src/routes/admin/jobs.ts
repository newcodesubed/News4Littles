/**
 * Which background job holds the lock, so the admin header can say a scrape or
 * batch is running before a click meets "already running".
 */
import { Router } from 'express';
import { activeJob } from '../../services/jobLock.js';

export function createJobsRouter(): Router {
  const router = Router();

  router.get('/jobs/active', (_req, res) => {
    res.json({ job: activeJob() });
  });

  return router;
}
