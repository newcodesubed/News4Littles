import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    // Each suite opens its own SQLite file; running files in parallel is fine,
    // but tests inside a file share a database and must stay ordered.
    fileParallelism: true,
    sequence: { concurrent: false },
  },
});
