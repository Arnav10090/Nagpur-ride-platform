import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: { alias: { 'react-native': 'react-native-web' }, dedupe: ['react', 'react-dom'] },
  esbuild: { jsx: 'automatic', tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false, jsx: 'react-jsx' } } },
  test: { fileParallelism: false, testTimeout: 30_000, hookTimeout: 30_000, include: ['test/**/*.test.ts', 'packages/**/test/**/*.test.{ts,tsx}', 'apps/**/test/**/*.test.{ts,tsx}'] },
});
