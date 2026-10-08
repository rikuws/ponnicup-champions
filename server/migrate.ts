import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { pool, transaction } from './db';

export async function migrate() {
  const directory = new URL('./migrations/', import.meta.url);
  const files = (await readdir(directory)).filter((file) => /^\d.*\.sql$/.test(file)).sort();
  await transaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('ponnicup:migrations'))");
    await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const applied = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((row) => row.name));
    for (const file of files) {
      if (applied.has(file)) continue;
      await db.query(await readFile(new URL(file, directory), 'utf8'));
      await db.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
      console.info(`Applied ${file}`);
    }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrate().then(() => pool.end()).catch(async (error) => {
    console.error(error); await pool.end(); process.exitCode = 1;
  });
}
