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
import { SCHEMA_VERSION } from './db/init.js';
import { CORS_ORIGINS, DATABASE_PATH } from './env.js';
import { createAdminAuth } from './http/middleware/adminAuth.js';
import { errorHandler, notFoundHandler } from './http/middleware/errorHandler.js';
import { createRequestLogger } from './http/middleware/requestLogger.js';
import { logger as defaultLogger, type Logger } from './logger.js';
import { createArticleActionsRouter } from './routes/admin/articleActions.js';
import { createArticleBulkRouter } from './routes/admin/articleBulk.js';
import { createArticleQueueRouter } from './routes/admin/articleQueue.js';
import { createPromptsRouter } from './routes/admin/prompts.js';
import { createRawArticlesRouter } from './routes/admin/rawArticles.js';
import { createScrapeRouter } from './routes/admin/scrape.js';
import { createSettingsRouter } from './routes/admin/settings.js';
import { createSourcesRouter } from './routes/admin/sources.js';
import { createStoriesRouter } from './routes/admin/stories.js';
import { createSubmitRouter } from './routes/admin/submit.js';
import { createArticlesRouter } from './routes/public/articles.js';
import { createAudioRouter } from './routes/public/audio.js';

/** Mounted in order; the literal paths must come before any that take an :id. */
const ADMIN_ROUTERS = [
  createArticleBulkRouter,
  createArticleQueueRouter,
  createStoriesRouter,
  createSubmitRouter,
  createSourcesRouter,
  createSettingsRouter,
  createPromptsRouter,
  createRawArticlesRouter,
  createScrapeRouter,
  createArticleActionsRouter,
];

/**
 * Refuse to start against a database older than the code.
 *
 * Repositories prepare their statements when they are constructed, so a
 * missing column otherwise surfaces as `table raw_articles has no column named
 * simplifiedAt` thrown from inside a repository factory — which says nothing
 * about the fix. `npm run db:init` migrates in place; it is idempotent.
 */
function requireCurrentSchema(db: Database): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version >= SCHEMA_VERSION) return;

  throw new Error(
    `The database is schema version ${version}, but this code needs ${SCHEMA_VERSION}. ` +
      'Run `npm run db:init` to migrate it (safe to re-run, and it keeps your data).',
  );
}

export interface AppOptions {
  logger?: Logger;
}

export function createApp(db: Database = openDatabase(), { logger = defaultLogger }: AppOptions = {}) {
  requireCurrentSchema(db);

  const app = express();

  app.use(cors({ origin: CORS_ORIGINS }));
  // Before the body parser, so a request rejected as bad JSON is still logged.
  app.use(createRequestLogger(logger));
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, database: DATABASE_PATH });
  });

  // Everything under /api/admin requires Basic Auth (§4.1).
  const adminAuth = createAdminAuth(db);
  for (const createRouter of ADMIN_ROUTERS) {
    app.use('/api/admin', adminAuth, createRouter(db));
  }

  // Audio first: '/articles/:id/audio' is two segments and '/articles/:id' is
  // one, so they cannot actually collide — the order is for readers, not routing.
  app.use('/api', createAudioRouter(db));
  app.use('/api', createArticlesRouter(db));

  app.use(notFoundHandler);
  // Must be last: Express identifies the error handler by its four arguments.
  app.use(errorHandler);

  return app;
}
