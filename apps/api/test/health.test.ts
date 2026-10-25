import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { buildModule, ErrorFilter } from '../src/http/app.module';
import { noopRateLimiters } from '../src/http/rateLimit';
import { closePool, makeDb, PG_URL } from './harness';

let app: any, http: any;

beforeAll(async () => {
  const db = await makeDb(PG_URL ? 'postgres' : 'memory');
  app = await NestFactory.create(buildModule({ db, accessKey: 'test-key', now: () => Date.now(), rateLimiters: noopRateLimiters(),
    sender: { async send() {} } }), { logger: false });
  app.useGlobalFilters(new ErrorFilter()); await app.init(); http = app.getHttpServer();
});
afterAll(async () => { await app.close(); await closePool(); });

describe('health probes', () => {
  it('GET /health returns 200 with uptime', async () => {
    const r = await request(http).get('/health').expect(200);
    expect(r.body.status).toBe('ok');
    expect(r.body.uptime).toBeTypeOf('number');
  });

  it('GET /health requires no auth', async () => {
    // No Authorization header — should still work
    const r = await request(http).get('/health').expect(200);
    expect(r.body.status).toBe('ok');
  });

  it('GET /ready returns 200 when the DB is up (memory store always passes)', async () => {
    const r = await request(http).get('/ready').expect(200);
    expect(r.body.status).toBe('ready');
  });
});
