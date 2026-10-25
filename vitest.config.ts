import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { fileParallelism: false, testTimeout: 20000, hookTimeout: 20000, include: ['apps/api/test/**/*.test.ts'], exclude: ['**/node_modules/**', 'mobile/**'] } });
