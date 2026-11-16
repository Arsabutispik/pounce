import { pathToFileURL } from "node:url";
import pg from "pg";
import { MIGRATIONS } from "./migrations.js";

const LOCK_KEY = 727274; // arbitrary app-wide advisory lock id, so two bots can't migrate at once

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
  return url;
}

/** Apply any migrations that haven't run yet. Safe to call on every startup. */
export async function migrate(pool: pg.Pool): Promise<string[]> {
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(
      "create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())",
    );
    const done = new Set((await client.query<{ id: string }>("select id from schema_migrations")).rows.map((r) => r.id));

    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      await client.query("begin");
      try {
        await client.query(m.sql);
        await client.query("insert into schema_migrations (id) values ($1)", [m.id]);
        await client.query("commit");
        applied.push(m.id);
      } catch (e) {
        await client.query("rollback");
        throw new Error(`Migration ${m.id} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
  return applied;
}

/** Connect with a throwaway pool, migrate, disconnect. Used at startup and by the CLI. */
export async function runMigrations(url = databaseUrl()): Promise<string[]> {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    return await migrate(pool);
  } finally {
    await pool.end();
  }
}

// `node dist/db/migrate.js` (the `mise run db:migrate` task)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMigrations()
    .then((applied) => console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date."))
    .catch((e) => {
      console.error(e.message ?? e);
      process.exit(1);
    });
}
