import { existsSync, mkdirSync, readFileSync } from "node:fs";
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
  /** Postgres only: run a task while this server holds the booking lock. */
  lock?<T>(task: () => Promise<T>): Promise<T>;
  /** True when other servers can use the same database at the same time. */
  shared: boolean;
}

/** Advisory lock keys. Any fixed numbers work; they only have to differ. */
export const BOOKING_LOCK_KEY = 7_055_901;
const SCHEMA_LOCK_KEY = 7_055_902;

/** The part of a `pg` client that the booking lock needs. */
export interface LockClient {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  /** Give the connection back. Pass true to throw it away instead. */
  release(destroy?: boolean): void;
}

/**
 * Hold the booking lock on one connection while a task runs.
 *
 * The lock lives in a transaction, so it also works through a connection
 * pooler (PgBouncer, Neon) in transaction mode. The task's own queries use
 * other connections. The lock ends when the transaction ends, also when the
 * connection is lost.
 */
export async function runLocked<T>(connect: () => Promise<LockClient>, task: () => Promise<T>): Promise<T> {
  const client = await connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [BOOKING_LOCK_KEY]);
  } catch (err) {
    client.release(true);
    throw err;
  }
  try {
    return await task();
  } finally {
    try {
      await client.query("COMMIT");
      client.release();
    } catch {
      client.release(true);
    }
  }
}

type PoolHook = (pool: unknown) => void;
let poolHook: PoolHook | null = null;

/** The host can watch the connection pool (Vercel closes idle connections before it pauses a function). */
export function setPoolHook(hook: PoolHook | null): void {
  poolHook = hook;
}

/** True when the code runs on Vercel. */
export function onVercel(): boolean {
  return Boolean(process.env.VERCEL);
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
  // On Vercel many small servers share the database, so each one keeps few connections and drops idle ones fast.
  const pool = new pg.Pool(onVercel() ? { connectionString: url, max: 5, idleTimeoutMillis: 5000 } : { connectionString: url });
  // An idle client that loses its connection must not crash the server.
  pool.on("error", (err: Error) => console.error("[db] idle client error:", err.message));
  poolHook?.(pool);
  const connect = async (): Promise<LockClient> => {
    const client = await pool.connect();
    // A client in use that loses its connection must not crash the server either.
    const quiet = (): void => undefined;
    client.on("error", quiet);
    return {
      query: (sql, params) => client.query(sql, params as unknown[]),
      release(destroy) {
        client.removeListener("error", quiet);
        client.release(destroy);
      },
    };
  };
  return {
    shared: true,
    lock: (task) => runLocked(connect, task),
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
    shared: false,
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
  const beside = resolve(here, "schema.sql");
  // A bundler (Vercel) can move this module. The file is then still at its path in the project.
  return readFileSync(existsSync(beside) ? beside : resolve(process.cwd(), "src/server/schema.sql"), "utf8");
}

async function open(url: string | undefined): Promise<Driver> {
  const target = (url ?? "").trim();
  let driver: Driver;
  if (target === "" && onVercel()) {
    throw new Error("DATABASE_URL is not set. On Vercel, Tolly needs a Postgres database.");
  }
  if (target === "") driver = await pgliteDriver("./.data/pglite");
  else if (target.startsWith("pglite:")) driver = await pgliteDriver(target.slice("pglite:".length) || "memory");
  else driver = await pgDriver(target);
  // The schema is idempotent. Apply it on every start.
  // Two servers can start at the same moment. The lock makes them apply it one after the other.
  // (Statements sent together run in one transaction, and the lock ends with it.)
  const first = driver.shared ? `SELECT pg_advisory_xact_lock(${SCHEMA_LOCK_KEY});\n` : "";
  await driver.exec(first + schemaSql());
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

/**
 * Run a task while this server holds the booking lock in the database.
 * With embedded PGlite there is only one server, so the task just runs.
 */
export async function withDbLock<T>(task: () => Promise<T>): Promise<T> {
  const db = await initDB();
  return db.lock ? db.lock(task) : task();
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
