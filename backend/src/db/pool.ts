import { Pool } from 'pg';

export function createDatabasePool(connectionString: string): Pool {
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
  });

  pool.on('error', () => {
    console.error('PostgreSQL connection is unavailable.');
  });

  return pool;
}
