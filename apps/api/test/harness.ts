import { Pool } from 'pg';
import { Store } from '../src/domain/memory';
import { Db } from '../src/domain/ports';
import { PgDb } from '../src/pg/PgDb';
import { migrate } from '../src/pg/migrate';

export const PG_URL = process.env.TEST_DATABASE_URL;
const TABLES = ['ReconciliationFinding', 'Refund', 'PaymentEvent', 'PaymentAttempt', 'Payment', 'Session', 'OtpChallenge', 'User', 'LedgerEntry', 'LedgerTransaction', 'AuditLog', 'OutboxEvent', 'IdempotencyRecord', 'DriverProfile', 'DriverPresence', 'RideEvent', 'RideOffer', 'RideAssignment', 'Ride', 'FareQuote'];

let pool: Pool | undefined;
export const getPool = () => (pool ??= new Pool({ connectionString: PG_URL, max: 25 }));
export async function resetPg() { await migrate(getPool()); await getPool().query(`TRUNCATE ${TABLES.map(t => `"${t}"`).join(',')} CASCADE`); }

export async function makeDb(kind: 'memory' | 'postgres'): Promise<Db> {
  if (kind === 'memory') return new Store();
  await resetPg(); return new PgDb(getPool());
}
export const closePool = async () => { await pool?.end(); pool = undefined; };
