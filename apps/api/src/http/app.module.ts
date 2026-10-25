import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Module } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DispatchService, Store } from '../domain/dispatch';
import { Db } from '../domain/ports';
import { DomainError } from '../domain/errors';
import { AuthGuard, AuthService, OtpSender, Role } from './auth';
import { AdminController, AuthController, DevPaymentsController, DriversController, PaymentsController, RidesController, WebhooksController } from './controllers';
import { HealthController, ReadinessError } from './health';
import { PaymentService } from '../domain/payments/service';
import { PaymentProvider } from '../domain/payments/provider';
import { FakeProvider } from '../domain/payments/fakeProvider';
import { randomBytes } from 'node:crypto';
import { PILOT_RULE, Platform } from './platform';
import { createRateLimiters, noopRateLimiters } from './rateLimit';
import type { RateLimiters } from './rateLimit';
import { LiveSink, noopSink } from './realtime';

const STATUS: Record<string, number> = { NOT_FOUND: 404, FORBIDDEN: 403, NOT_ASSIGNED_DRIVER: 403, QUOTE_EXPIRED: 410 };

@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse(); const requestId = randomUUID();
    if (e instanceof ReadinessError) return res.status(503).json(e.body);
    if (e instanceof DomainError) return res.status(STATUS[e.code] ?? 409).json(e.toEnvelope(requestId));
    if (e instanceof HttpException) {
      const b = e.getResponse() as any;
      return res.status(e.getStatus()).json({ error: { code: b.code ?? 'ERROR', message: b.message ?? e.message, retryable: e.getStatus() === 429 }, meta: { requestId } });
    }
    console.error(requestId, e); // never leak internals
    return res.status(500).json({ error: { code: 'INTERNAL', message: 'Unexpected error', retryable: true }, meta: { requestId } });
  }
}

export interface AppOptions { paymentProvider?: PaymentProvider; devTools?: { webhookUrl: string }; db?: Db; hub?: LiveSink; sender: OtpSender; now?: () => number; accessKey?: string; adminPhones?: Record<string, Role>; rateLimiters?: RateLimiters }
export function buildModule(o: AppOptions) {
  const now = o.now ?? Date.now;
  const db: Db = o.db ?? new Store();
  const provider: PaymentProvider = o.paymentProvider ?? new FakeProvider({ secret: randomBytes(32).toString('hex'), now });
  const payments = new PaymentService(db, provider, { commissionBps: PILOT_RULE.commissionBps, now });
  @Module({
    controllers: [HealthController, AuthController, RidesController, DriversController, AdminController, PaymentsController, WebhooksController, ...(o.devTools ? [DevPaymentsController] : [])],
    providers: [
      { provide: 'OTP_SENDER', useValue: o.sender },
      { provide: 'CONFIG', useValue: { accessKey: o.accessKey ?? process.env.ACCESS_TOKEN_SIGNING_KEY ?? (() => { throw new Error('ACCESS_TOKEN_SIGNING_KEY required'); })(), adminPhones: o.adminPhones ?? {}, now } },
      { provide: 'DB', useValue: db },
      { provide: 'RATE_LIMITERS', useValue: o.rateLimiters ?? createRateLimiters(now) },
      { provide: DispatchService, useValue: new DispatchService(db, { offerTimeoutMs: 15_000, locationFreshnessMs: 30_000, maxOffers: 5 }, now) },
      { provide: 'NOW', useValue: now },
      { provide: 'PAYMENT_PROVIDER', useValue: provider },
      { provide: PaymentService, useValue: payments },
      { provide: 'DEV_WEBHOOK_URL', useValue: o.devTools?.webhookUrl ?? '' },
      { provide: 'HUB', useValue: o.hub ?? noopSink },
      AuthService, AuthGuard, Platform,
    ],
  })
  class AppModule {}
  return AppModule;
}
