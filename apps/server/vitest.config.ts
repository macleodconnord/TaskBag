import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests share the dev Postgres and some assert on table-wide row counts: run files one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
