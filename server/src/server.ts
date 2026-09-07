/**
 * Process entry point: open the database, start listening, register the
 * scrape schedule. All Express wiring lives in app.ts.
 *
 *   npm run dev     — start with reload on change
 *   npm start       — start once
 *
 * Configuration lives in .env (see .env.example).
 */
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { openDatabase } from './db/connection.js';
import { CORS_ORIGINS, DATABASE_PATH, PORT } from './env.js';
import { startScrapeSchedule } from './ingestion/scheduler.js';

export { createApp };

function start(): void {
  // One connection shared by the request handlers and the cron jobs (§5.3).
  const db = openDatabase();

  createApp(db).listen(PORT, () => {
    console.log(`News4Littles API listening on http://localhost:${PORT}`);
    console.log(`  database     ${DATABASE_PATH}`);
    console.log(`  CORS origins ${CORS_ORIGINS.join(', ')}`);
    console.log('');
    console.log('  GET /api/health');
    console.log('  GET /api/articles[?status=pending_review|published|rejected]');
    console.log('  GET /api/articles/:id');
    console.log('  /api/admin/*  (Basic Auth)');
    console.log('');

    // §5.3: register the configured scrape times. Failures are logged by the
    // scheduler and never bring the API down.
    startScrapeSchedule(db);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) start();
