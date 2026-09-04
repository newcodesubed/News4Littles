/**
 * News4Littles API server.
 *
 *   npm run dev     — start with reload on change
 *   npm start       — start once
 *
 * Configuration lives in .env (see .env.example).
 */
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { CORS_ORIGINS, DATABASE_PATH, PORT } from './env.js';
import { openDatabase } from './db/connection.js';
import { startScrapeSchedule } from './ingestion/scheduler.js';
import { createArticlesRouter } from './routes/articles.js';

export function createApp(db = openDatabase()) {
  const app = express();

  app.use(cors({ origin: CORS_ORIGINS }));
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, database: DATABASE_PATH });
  });

  app.use('/api', createArticlesRouter(db));

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });

  return app;
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);

if (isDirectRun) {
  // One connection for the request handlers and the cron jobs (§5.3).
  const db = openDatabase();

  createApp(db).listen(PORT, () => {
    console.log(`News4Littles API listening on http://localhost:${PORT}`);
    console.log(`  database     ${DATABASE_PATH}`);
    console.log(`  CORS origins ${CORS_ORIGINS.join(', ')}`);
    console.log(`\n  GET /api/health`);
    console.log(`  GET /api/articles[?status=pending_review|published|rejected]`);
    console.log(`  GET /api/articles/:id`);
    console.log('');

    // §5.3: register the configured scrape times. Failures here are logged by
    // the scheduler and never bring the API down.
    startScrapeSchedule(db);
  });
}
