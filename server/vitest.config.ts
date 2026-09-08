import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    /**
     * No test may call a paid API. The developer's .env has a real
     * OPENROUTER_KEY, and without this every ingestion test would spend money,
     * take seconds per article and produce non-deterministic output.
     *
     * Tests that need the LLM path inject a stub client instead. The one live
     * check is a standalone script, run deliberately.
     */
    env: { LLM_ENABLED: 'false' },
    include: ['tests/**/*.test.ts'],
    // Each suite opens its own SQLite file; running files in parallel is fine,
    // but tests inside a file share a database and must stay ordered.
    fileParallelism: true,
    sequence: { concurrent: false },
  },
});
