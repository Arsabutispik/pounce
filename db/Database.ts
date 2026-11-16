import { Injectable } from "stoatx";
import pg from "pg";
import { databaseUrl } from "./migrate.js";

/** One shared connection pool for the whole bot (singleton via stoatx DI). */
@Injectable()
export class Database {
  private readonly pool = new pg.Pool({ connectionString: databaseUrl(), max: 5 });

  constructor() {
    // An idle client can error (e.g. the DB restarts). Log it instead of crashing the process.
    this.pool.on("error", (e) => console.error("postgres pool error:", e.message));
  }

  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]) {
    return this.pool.query<R>(text, params);
  }

  close() {
    return this.pool.end();
  }
}
