import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // Map workspace package sub-exports directly to TypeScript source so
      // vitest doesn't require a compiled dist/ directory to run tests.
      '@wafflefinance/config/node': resolve(__dirname, '../packages/config/src/node.ts'),
      '@wafflefinance/config': resolve(__dirname, '../packages/config/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    pool: 'forks',
  },
});
