import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

let cached: Db | undefined;

export function getDb(connectionString?: string): Db {
  if (cached) return cached;
  const url = connectionString ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString: url });
  cached = drizzle(pool, { schema });
  return cached;
}

/** For tests / scripts: reset the cached client. */
export function _resetDbCache(): void {
  cached = undefined;
}
