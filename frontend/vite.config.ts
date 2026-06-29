import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import path from 'path'

const sdkSrc = path.resolve(__dirname, '../packages/sdk/src');

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, process.cwd(), '')
  
  const isProduction = mode === 'production';

  return {
    plugins: [
      nodePolyfills({
        globals: {
          Buffer: true,
          global: true,
          process: true,
        },
      }),
      react()
    ],
    resolve: {
      alias: [
        // Resolve workspace SDK directly from TypeScript source so no
        // separate build step is needed during local development.
        { find: /^@wafflefinance\/sdk\/(.+)$/, replacement: `${sdkSrc}/$1/index.ts` },
        { find: '@wafflefinance/sdk', replacement: `${sdkSrc}/index.ts` },
        { find: '@', replacement: path.resolve(__dirname, './src') },
      ],
    },
    server: {
      port: Number(env.VITE_APP_PORT) || 5173,
      host: env.VITE_APP_HOST || 'localhost',
      open: false,
      cors: true,
    },
    // Strip all console.* calls and debugger statements from production
    // bundles. Local development still logs normally. This avoids leaking
    // wallet addresses, order payloads, balances and other runtime state
    // through devtools when users hit the public deployment.
    esbuild: isProduction
      ? {
          drop: ['console', 'debugger'],
          legalComments: 'none',
        }
      : {},
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      // Disable inline source maps in production to avoid handing reviewers
      // a fully reconstructable source tree from the public bundle.
      sourcemap: isProduction ? false : true,
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ['react', 'react-dom'],
            ui: ['@rainbow-me/rainbowkit', 'wagmi'],
            crypto: ['ethers'],
          },
        },
      },
    },
    define: {
      // Expose environment variables to the client
      __APP_VERSION__: JSON.stringify(process.env.npm_package_version),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
    // Environment variables validation
    envPrefix: 'VITE_',
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'ethers',
        '@rainbow-me/rainbowkit',
        'wagmi',
      ],
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: './src/test/setup.ts',
    },
  }
}) 