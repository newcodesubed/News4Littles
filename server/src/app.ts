/**
 * Express wiring: which middleware runs, in which order, around which routes.
 *
 * Deliberately has no `listen` and no scheduler, so tests can build an app
 * against a throwaway database without starting anything.
 */
import cors from 'cors';
import express from 'express';
import type { Database } from 'better-sqlite3';
import { openDatabase } from './db/connection.js';
import { CORS_ORIGINS, DATABASE_PATH } from './env.js';
import { createAdminAuth } from './http/middleware/adminAuth.js';
import { errorHandler, notFoundHandler } from './http/middleware/errorHandler.js';
import { createArticleActionsRouter } from './routes/admin/articleActions.js';
import { createArticleBulkRouter } from './routes/admin/articleBulk.js';
import { createArticleQueueRouter } from './routes/admin/articleQueue.js';
import { createSettingsRouter } from './routes/admin/settings.js';
import { createSourcesRouter } from './routes/admin/sources.js';
import { createSubmitRouter } from './routes/admin/submit.js';
import { createArticlesRouter } from './routes/public/articles.js';

/** Mounted in order; the literal paths must come before any that take an :id. */
const ADMIN_ROUTERS = [
  createArticleBulkRouter,
  createArticleQueueRouter,
  createSubmitRouter,
  createSourcesRouter,
  createSettingsRouter,
  createArticleActionsRouter,
];

export function createApp(db: Database = openDatabase()) {
  const app = express();

  app.use(cors({ origin: CORS_ORIGINS }));
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, database: DATABASE_PATH });
  });

  // Everything under /api/admin requires Basic Auth (§4.1).
  const adminAuth = createAdminAuth(db);
  for (const createRouter of ADMIN_ROUTERS) {
    app.use('/api/admin', adminAuth, createRouter(db));
  }

  app.use('/api', createArticlesRouter(db));

  app.use(notFoundHandler);
  // Must be last: Express identifies the error handler by its four arguments.
  app.use(errorHandler);

  return app;
}
