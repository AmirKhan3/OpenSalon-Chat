import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Database access.
 *
 * - DATABASE_URL set to a postgres:// URL: use `pg` (a connection pool).
 * - DATABASE_URL empty, or "pglite:<dir>" / "pglite:memory": use embedded
 *   PGlite, so development and tests need no database installed.
 *
 * Route code writes "?" placeholders. They are rewritten to $1, $2, ... here.
 */

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

interface Driver {
  query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[]; affectedRows: number }>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

const INT8 = 20;
const NUMERIC = 1700;

let driverPromise: Promise<Driver> | null = null;
let generation = 0;

/** Changes every time the database is replaced (tests). Lets callers drop caches. */
export function dbGeneration(): number {
  return generation;
}

/**
 * Rewrite "?" placeholders to $1, $2, ...
 * A "?" inside a quoted string, a quoted identifier, or a comment is left alone.
 */
export function rewritePlaceholders(sql: string): string {
  let out = "";
  let n = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      // Copy the quoted part. A doubled quote is an escaped quote.
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) { j += 2; continue; }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "-" && sql[i + 1] === "-") {
      let j = sql.indexOf("\n", i);
      if (j === -1) j = sql.length;
      out += sql.slice(i, j);
      i = j;
    } else if (ch === "/" && sql[i + 1] === "*") {
      let j = sql.indexOf("*/", i + 2);
      j = j === -1 ? sql.length : j + 2;
      out += sql.slice(i, j);
      i = j;
    } else if (ch === "?") {
      out += `$${++n}`;
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** A plain INSERT gets "RETURNING id", so callers can read lastInsertRowid. */
export function withReturningId(sql: string): string {
  if (!/^\s*INSERT\s/i.test(sql)) return sql;
  if (/\bRETURNING\b/i.test(sql) || /\bON\s+CONFLICT\b/i.test(sql)) return sql;
  return `${sql.replace(/;\s*$/, "")} RETURNING id`;
}

/** undefined is not a valid SQL value; send NULL instead. */
function clean(params: unknown[]): unknown[] {
  return params.map((p) => (p === undefined ? null : p));
}

async function pgDriver(url: string): Promise<Driver> {
  const pg = (await import("pg")).default;
  pg.types.setTypeParser(INT8, (v: string) => Number(v));
  pg.types.setTypeParser(NUMERIC, (v: string) => parseFloat(v));
  const pool = new pg.Pool({ connectionString: url });
  // An idle client that loses its connection must not crash the server.
  pool.on("error", (err: Error) => console.error("[db] idle client error:", err.message));
  return {
    async query(sql, params) {
      const r = await pool.query(sql, params);
      return { rows: r.rows ?? [], affectedRows: r.rowCount ?? 0 };
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async close() {
      await pool.end();
    },
  };
}

async function pgliteDriver(target: string): Promise<Driver> {
  const { PGlite } = await import("@electric-sql/pglite");
  let dataDir: string | undefined;
  if (target !== "memory") {
    dataDir = resolve(target);
    mkdirSync(dataDir, { recursive: true });
  }
  const db = new PGlite(dataDir ? { dataDir } : {});
  await db.waitReady;
  const parsers = { [INT8]: (v: string) => Number(v), [NUMERIC]: (v: string) => parseFloat(v) };
  return {
    async query(sql, params) {
      const r = await db.query<Record<string, unknown>>(sql, params, { parsers });
      return { rows: r.rows ?? [], affectedRows: r.affectedRows ?? 0 };
    },
    async exec(sql) {
      await db.exec(sql);
    },
    async close() {
      await db.close();
    },
  };
}

function schemaSql(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, "schema.sql"), "utf8");
}

async function open(url: string | undefined): Promise<Driver> {
  const target = (url ?? "").trim();
  let driver: Driver;
  if (target === "" ) driver = await pgliteDriver("./.data/pglite");
  else if (target.startsWith("pglite:")) driver = await pgliteDriver(target.slice("pglite:".length) || "memory");
  else driver = await pgDriver(target);
  // The schema is idempotent. Apply it on every start.
  await driver.exec(schemaSql());
  return driver;
}

/** Open the database (once) and apply the schema. */
export function initDB(url: string | undefined = process.env.DATABASE_URL): Promise<Driver> {
  if (!driverPromise) {
    generation++;
    driverPromise = open(url);
    driverPromise.catch(() => { driverPromise = null; });
  }
  return driverPromise;
}

/** Close the database. The next query opens it again. */
export async function closeDB(): Promise<void> {
  const p = driverPromise;
  driverPromise = null;
  if (p) {
    try { await (await p).close(); } catch { /* already closed */ }
  }
}

/** Tests: throw away the current database and open a new one. */
export async function resetDB(url = "pglite:memory"): Promise<void> {
  await closeDB();
  await initDB(url);
}

/** Run a query and return all rows. */
export async function query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await initDB();
  const r = await db.query(rewritePlaceholders(sql), clean(params));
  return r.rows as T[];
}

/** Run a query and return the first row, or undefined. */
export async function get<T = any>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await query<T>(sql, params);
  return rows[0];
}

/** Run a statement that changes data. */
export async function run(sql: string, params: unknown[] = []): Promise<RunResult> {
  const db = await initDB();
  const r = await db.query(rewritePlaceholders(withReturningId(sql)), clean(params));
  const id = r.rows[0]?.id;
  return { changes: r.affectedRows || r.rows.length, lastInsertRowid: typeof id === "number" ? id : Number(id ?? 0) };
}

/** Run several statements with no parameters (schema changes). */
export async function exec(sql: string): Promise<void> {
  const db = await initDB();
  await db.exec(sql);
}
