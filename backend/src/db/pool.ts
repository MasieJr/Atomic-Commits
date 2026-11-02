import { Pool } from 'pg';

export function createDatabasePool(connectionString: string): Pool {
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 60000,
    keepAlive: true,
    query_timeout: 5000,
  });

  pool.on('error', () => {
    console.error('PostgreSQL connection is unavailable.');
  });

  return pool;
}
