import 'dotenv/config';

import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createDatabasePool } from './src/db/pool';

async function migrate(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Set DATABASE_URL before running database migrations.');

  const pool = createDatabasePool(databaseUrl);
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(470021)');
      await client.query('CREATE SCHEMA IF NOT EXISTS app_private');
      await client.query('REVOKE ALL ON SCHEMA app_private FROM PUBLIC');
      await client.query(`CREATE TABLE IF NOT EXISTS app_private.schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

      const directory = resolve(__dirname, '../sql');
      const files = (await readdir(directory)).filter((file) => /^\d+_.*\.sql$/.test(file)).sort();

      for (const file of files) {
        const applied = await client.query('SELECT version FROM app_private.schema_migrations WHERE version = $1', [file]);
        if (applied.rowCount) continue;

        await client.query(await readFile(resolve(directory, file), 'utf8'));
        await client.query('INSERT INTO app_private.schema_migrations (version) VALUES ($1)', [file]);
      }

      await client.query('COMMIT');
      console.log('Database migrations are up to date.');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

void migrate().catch(() => {
  console.error('Database migration failed. Check DATABASE_URL, database connectivity, and schema permissions.');
  process.exitCode = 1;
});
