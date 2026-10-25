import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
// Served by the API server at /console (same origin: no CORS). Output must contain no inline script or style (strict CSP).
export default defineConfig({ base: '/console/', plugins: [react()], build: { outDir: 'dist', sourcemap: false, assetsInlineLimit: 0, cssCodeSplit: false } });
