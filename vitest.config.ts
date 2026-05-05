import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    maxWorkers: '50%',
    minWorkers: 1,
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: {
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/agendo_test',
      JWT_SECRET: 'test-secret-at-least-16-chars',
      NODE_ENV: 'test',
    },
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
