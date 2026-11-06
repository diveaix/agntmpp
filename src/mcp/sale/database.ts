import { Pool, type PoolClient } from 'pg'
import { readFile } from 'node:fs/promises'
import { CURVE_VERSION, SCHEDULE_HASH, SaleError } from './pricing.js'
import { DepositAssignments } from './deposit-assignments.js'

let pool: Pool | undefined
export function salePool(): Pool {
  if (!process.env.AGNT_SALE_DATABASE_URL) throw new SaleError('sale_database_unconfigured', 503)
  return pool ??= new Pool({ connectionString: process.env.AGNT_SALE_DATABASE_URL, max: 8, connectionTimeoutMillis: 5000, statement_timeout: 10000 })
}
export async function transaction<T>(run: (client: PoolClient) => Promise<T>, db = salePool()): Promise<T> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const result = await run(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}
export async function migrateSale(db = salePool()): Promise<void> {
  await db.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'))
  await new DepositAssignments(db).migrate()
  await db.query('INSERT INTO agnt_sale(id,curve_version,schedule_hash) VALUES(1,$1,$2) ON CONFLICT DO NOTHING', [CURVE_VERSION, SCHEDULE_HASH])
  const row = (await db.query('SELECT * FROM agnt_sale WHERE id=1')).rows[0]
  if (row.curve_version !== CURVE_VERSION || row.schedule_hash !== SCHEDULE_HASH) throw new SaleError('curve_version_mismatch', 503)
}
