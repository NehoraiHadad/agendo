import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: {
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/agendo_test',
      JWT_SECRET: 'test-secret-at-least-16-chars',
      NODE_ENV: 'test',
    },
    // Demo-mode short-circuit tests use `vi.resetModules + await import()` which
    // re-evaluates the full transitive import graph; under parallel load this
    // occasionally exceeds the default 5s. Also accommodates PATH-scanner tests
    // that do real filesystem traversal in CI containers.
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/lib/**/*.ts'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
