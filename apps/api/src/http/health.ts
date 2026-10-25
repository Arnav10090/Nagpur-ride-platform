import { Controller, Get, Inject } from '@nestjs/common';
import { Db } from '../domain/ports';

/**
 * Kubernetes-style health probes. No auth required.
 * - GET /health  — liveness: the process is running and serving HTTP.
 * - GET /ready   — readiness: the database is reachable and migrations are applied.
 */
@Controller()
export class HealthController {
  constructor(@Inject('DB') private db: Db) {}

  /** Liveness: always 200 if the process is up. Load balancers hit this. */
  @Get('health')
  liveness() {
    return { status: 'ok', uptime: Math.floor(process.uptime()) };
  }

  /** Readiness: verifies the DB connection is working. Returns 503 if not ready. */
  @Get('ready')
  async readiness() {
    try {
      // Run a trivial query through the Db.tx path to verify the pool, connection, and schema are all working.
      await this.db.tx(async r => {
        // summaryCounts touches multiple tables; if migrations haven't run this throws.
        await r.summaryCounts();
      });
      return { status: 'ready' };
    } catch (e: any) {
      // Return 503 so the load balancer doesn't route traffic here yet.
      const res = { status: 'not_ready', reason: e?.message ?? 'database unreachable' };
      // NestJS will default to 200 unless we throw; use a manual approach via @Res or throw an HttpException.
      // We want a clean JSON body, so throw a typed response.
      throw new ReadinessError(res);
    }
  }
}

/** Thrown by the readiness check so the ErrorFilter can render 503. */
export class ReadinessError {
  constructor(public body: { status: string; reason: string }) {}
}
