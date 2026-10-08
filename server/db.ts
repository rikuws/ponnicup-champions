import pg, { type PoolClient, type QueryResultRow } from 'pg';

if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required in production.');
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  // Railway private networking does not require TLS. Public providers should
  // express their certificate policy in DATABASE_URL (for example sslmode=verify-full).
});
pool.on('error', (error) => console.error('Idle PostgreSQL connection failed:', error.message));
export type Db = Pick<PoolClient, 'query'>;
export function query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]) {
  return pool.query<T>(sql, values);
}
export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '15s'");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
