import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@wafflefinance/config/node': resolve(__dirname, '../packages/config/src/node.ts'),
      '@wafflefinance/config': resolve(__dirname, '../packages/config/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/smoke/**/*.ts'],
    exclude: ['test/smoke/helpers.ts'],
    pool: 'forks',
    testTimeout: 30000,
    hookTimeout: 10000,
  },
});
