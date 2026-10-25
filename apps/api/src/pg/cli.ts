import 'dotenv/config';
import { Pool } from 'pg';
import { migrate } from './migrate';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
migrate(pool).then(a => { console.log(a.length ? `applied: ${a.join(', ')}` : 'up to date'); return pool.end(); }).catch(e => { console.error(e.message); process.exit(1); });
