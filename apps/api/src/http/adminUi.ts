import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import express from 'express';

/** No inline script or style is allowed, no framing, and the console may only talk to its own origin. */
export const CONSOLE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

/** Serves the built staff console at /console from the same origin as the API (no CORS, no cross-site cookies or tokens). Returns false if it is not built. */
export function mountAdminUi(app: INestApplication, dir: string): boolean {
  const index = join(dir, 'index.html'); if (!existsSync(index)) return false;
  const server = app.getHttpAdapter().getInstance();
  server.use('/console', (_req: any, res: any, next: any) => {
    res.setHeader('Content-Security-Policy', CONSOLE_CSP); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()'); next();
  });
  server.use('/console', express.static(dir, { index: false, maxAge: '1y', immutable: true }));
  server.get(/^\/console(\/.*)?$/, (req: any, res: any) => {
    if (extname(req.path)) return res.status(404).end();            // a missing asset must be a 404, never the app shell
    res.setHeader('Cache-Control', 'no-store'); res.sendFile(index);
  });
  return true;
}
