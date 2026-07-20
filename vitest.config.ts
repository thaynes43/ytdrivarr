import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Embedded-Postgres boots take real time; give DB-backed suites room.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
