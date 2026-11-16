import "reflect-metadata"; // must be first: DI reads constructor types via emitted decorator metadata
import { Client } from "stoatx";
import { PREFIX } from "./config.js";
import { runMigrations } from "../db/migrate.js";

const token = process.env.STOAT_TOKEN;
if (!token) {
  console.error("Missing STOAT_TOKEN. Put it in .env or the environment.");
  process.exit(1);
}

// Create/upgrade the database schema before anything touches it.
try {
  const applied = await runMigrations();
  if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);
} catch (e) {
  console.error("Database not ready:", (e as Error).message);
  console.error("Is Postgres running? Try `mise run db:up`, and check DATABASE_URL in .env.");
  process.exit(1);
}

const client = new Client({ prefix: PREFIX });

await client.login(token);
console.log("Bot is running.");

// Clean shutdown on Ctrl+C / container stop.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`Received ${sig}, shutting down.`);
    process.exit(0);
  });
}
