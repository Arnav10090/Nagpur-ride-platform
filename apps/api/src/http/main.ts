import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import { DispatchService } from '../domain/dispatch';
import { Db } from '../domain/ports';
import { OutboxWorker } from '../domain/outbox';
import { PgDb } from '../pg/PgDb';
import { migrate } from '../pg/migrate';
import { AuthService } from './auth';
import { buildModule, ErrorFilter } from './app.module';
import { LiveHub } from './realtime';
import { PaymentService } from '../domain/payments/service';
import { FakeProvider } from '../domain/payments/fakeProvider';
import { Workers } from './workers';
import { mountAdminUi } from './adminUi';
import { fileURLToPath } from 'node:url';

async function bootstrap() {
  const url = process.env.DATABASE_URL;
  if (!url && process.env.NODE_ENV === 'production') throw new Error('DATABASE_URL is required in production');
  const db = url ? new PgDb(new Pool({ connectionString: url, max: Number(process.env.PG_POOL_MAX ?? 10) })) : undefined;
  if (db) console.log('migrations applied:', await migrate(db.pool));
  // ADMIN_PHONES="+919000000001:OPS_ADMIN,+919000000002:SUPER_ADMIN": staff roles are granted ONLY by this server-side allow-list.
  const adminPhones = Object.fromEntries((process.env.ADMIN_PHONES ?? '').split(',').filter(Boolean).map(x => x.split(':') as [string, any]));
  // PAYMENTS: only the FAKE provider exists so far. A real gateway implements PaymentProvider (domain/payments/provider.ts).
  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  if (process.env.NODE_ENV === 'production') throw new Error('No production payment provider is configured: implement PaymentProvider for your gateway');
  const port = Number(process.env.PORT ?? 3000);
  const paymentProvider = new FakeProvider({ secret: secret ?? 'dev-only-webhook-secret', now: Date.now });
  const devTools = process.env.ENABLE_DEV_TOOLS === '1' ? { webhookUrl: `http://127.0.0.1:${port}/api/v1/webhooks/payments/fake` } : undefined;
  const hub = new LiveHub();
  const app = await NestFactory.create(buildModule({
    db, hub, adminPhones, paymentProvider, devTools,
    // DEV ONLY sender: logs the OTP. Production must use a real SMS provider adapter.
    sender: { async send(phone, code) { if (process.env.NODE_ENV !== 'production') console.log(`[dev] OTP for ${phone}: ${code}`); else throw new Error('Configure OTP provider'); } },
  }), { rawBody: true }); // raw bytes are required to verify webhook signatures
  app.useGlobalFilters(new ErrorFilter());
  app.enableCors();
  app.enableShutdownHooks();
  const uiDir = process.env.ADMIN_UI_DIR ?? fileURLToPath(new URL('../../../../mobile/apps/admin/dist', import.meta.url));
  console.log(mountAdminUi(app, uiDir) ? `staff console: /console (from ${uiDir})` : 'staff console not built (cd mobile && npm run build:admin)');
  await app.init();
  hub.attach(app.getHttpServer(), app.get(AuthService));
  const store: Db = app.get('DB');
  const workers = new Workers(app.get(DispatchService), new OutboxWorker(store, hub), hub, app.get(PaymentService)); workers.start();
  await app.listen(port);
  const stop = async () => { workers.stop(); await hub.close(); await app.close(); await db?.close(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
bootstrap();
