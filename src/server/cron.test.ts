import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

process.env.SEED_DEMO_DATA = "false";
process.env.STAFF_PASSWORD = "correct horse";
process.env.SESSION_SECRET = "test-session-secret";

const db = await import("./db.js");
const { default: app } = await import("./index.js");
const { runTimers, CRON_PATH } = await import("./cron.js");
const { countHit } = await import("./ratelimit.js");
const { keepAlive, setKeepAlive } = await import("./background.js");

after(() => db.closeDB());

beforeEach(async () => {
  delete process.env.CRON_SECRET;
  setKeepAlive(null);
  await db.resetDB("pglite:memory");
});

function call(authorization?: string) {
  return app.request(CRON_PATH, { headers: authorization ? { authorization } : {} });
}

async function limitRows(): Promise<number> {
  return Number((await db.query<{ n: number }>("SELECT COUNT(*) AS n FROM rate_limits"))[0].n);
}

test("the cron route is off when CRON_SECRET is not set", async () => {
  assert.equal((await call()).status, 404);
  assert.equal((await call("Bearer ")).status, 404);
  assert.equal((await call("Bearer undefined")).status, 404);
});

test("the cron route refuses a missing or wrong secret", async () => {
  process.env.CRON_SECRET = "a-long-cron-secret";
  await countHit("test:old", 1000, 1000);
  for (const value of [undefined, "", "Bearer", "Bearer wrong", "a-long-cron-secret", "bearer a-long-cron-secret", "Bearer a-long-cron-secret-and-more"]) {
    const res = await call(value);
    assert.equal(res.status, 401, String(value));
    assert.deepEqual(await res.json(), { error: "Please log in." });
  }
  // Nothing ran.
  assert.equal(await limitRows(), 1);
});

test("the cron route runs the timers with the right secret, without a staff login", async () => {
  process.env.CRON_SECRET = "a-long-cron-secret";
  await countHit("test:old", 1000, 1000);
  await countHit("test:new", Date.now(), 3_600_000);
  const res = await call("Bearer a-long-cron-secret");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, failed: [] });
  // The window that ended is gone. The one that still runs stays.
  const rows = await db.query<{ key: string }>("SELECT key FROM rate_limits");
  assert.deepEqual(rows.map((r) => r.key), ["test:new"]);
});

test("the cron route only answers GET", async () => {
  process.env.CRON_SECRET = "a-long-cron-secret";
  const res = await app.request(CRON_PATH, { method: "POST", headers: { authorization: "Bearer a-long-cron-secret" } });
  assert.notEqual(res.status, 200);
});

test("runTimers is safe to run twice at the same moment", async () => {
  await countHit("test:old", 1000, 1000);
  const [a, b] = await Promise.all([runTimers(), runTimers()]);
  assert.deepEqual(a, []);
  assert.deepEqual(b, []);
  assert.equal(await limitRows(), 0);
});

test("runTimers reports a step that failed and still runs the others", async () => {
  await countHit("test:old", 1000, 1000);
  await db.run("ALTER TABLE automations RENAME TO automations_gone");
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    assert.deepEqual(await runTimers(), ["automations"]);
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1);
  assert.equal(await limitRows(), 0);
});

test("keepAlive does nothing without a host, and passes the work to the host's hook", async () => {
  keepAlive(Promise.resolve());
  const seen: Promise<unknown>[] = [];
  setKeepAlive((work) => { seen.push(work); });
  const work = Promise.resolve("done");
  keepAlive(work);
  assert.deepEqual(seen, [work]);
});

test("keepAlive never throws when the host's hook fails", async () => {
  setKeepAlive(() => { throw new Error("no request here"); });
  const original = console.error;
  console.error = () => {};
  try {
    assert.doesNotThrow(() => keepAlive(Promise.resolve()));
  } finally {
    console.error = original;
  }
});
