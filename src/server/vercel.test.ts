import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { after, beforeEach, test } from "node:test";

process.env.SEED_DEMO_DATA = "false";
process.env.STAFF_PASSWORD = "correct horse";
process.env.SESSION_SECRET = "test-session-secret";

const db = await import("./db.js");
const { handle, runScheduled, setupProblem } = await import("./vercel.js");
const { countHit } = await import("./ratelimit.js");
const { setKeepAlive, keepAlive } = await import("./background.js");

after(() => {
  setKeepAlive(null);
  db.setPoolHook(null);
  return db.closeDB();
});

beforeEach(async () => {
  process.env.STAFF_PASSWORD = "correct horse";
  process.env.SESSION_SECRET = "test-session-secret";
  // Tests use the embedded database. The value only has to be there.
  process.env.DATABASE_URL = "pglite:memory";
  await db.resetDB("pglite:memory");
});

after(() => { delete process.env.DATABASE_URL; });

async function quiet<T>(work: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try {
    return await work();
  } finally {
    console.error = original;
  }
}

test("setupProblem names the first setting that is missing", () => {
  assert.equal(setupProblem(), null);
  delete process.env.SESSION_SECRET;
  assert.match(setupProblem() ?? "", /^SESSION_SECRET is not set/);
  delete process.env.STAFF_PASSWORD;
  assert.match(setupProblem() ?? "", /^STAFF_PASSWORD is not set/);
  delete process.env.DATABASE_URL;
  assert.match(setupProblem() ?? "", /^DATABASE_URL is not set/);
});

test("a request gets a plain 503 when a setting is missing, and never reaches the app", async () => {
  delete process.env.STAFF_PASSWORD;
  const res = await quiet(() => handle(new Request("https://shop.example/api/clients")));
  assert.equal(res.status, 503);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /^Tolly is not set up yet\. STAFF_PASSWORD is not set/);
});

test("requests go to the app: open routes answer, staff routes need a login", async () => {
  const health = await handle(new Request("https://shop.example/api/health"));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  assert.equal((await handle(new Request("https://shop.example/api/clients"))).status, 401);

  const login = await handle(new Request("https://shop.example/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "correct horse" }),
  }));
  assert.equal(login.status, 200);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  assert.equal((await handle(new Request("https://shop.example/api/clients", { headers: { cookie } }))).status, 200);
});

test("the scheduled run does the timers' work", async () => {
  await countHit("test:old", 1000, 1000);
  await runScheduled();
  assert.equal((await db.query("SELECT key FROM rate_limits")).length, 0);
});

test("the scheduled run fails loudly when a setting is missing or a timer fails", async () => {
  delete process.env.SESSION_SECRET;
  await assert.rejects(() => runScheduled(), /SESSION_SECRET is not set/);
  process.env.SESSION_SECRET = "test-session-secret";
  await db.run("ALTER TABLE automations RENAME TO automations_gone");
  await quiet(() => assert.rejects(() => runScheduled(), /These timers failed: automations/));
});

test("work after the reply is given to the host (outside a request it must not throw)", async () => {
  await quiet(async () => assert.doesNotThrow(() => keepAlive(Promise.resolve())));
});

test("vercel.json points at files that exist", () => {
  const config = JSON.parse(readFileSync("vercel.json", "utf8")) as {
    functions: Record<string, { includeFiles?: string; experimentalTriggers?: { type: string }[] }>;
    schedules: Record<string, { schedule: string; function: string }>;
    rewrites: { source: string; destination: string }[];
  };
  for (const [file, options] of Object.entries(config.functions)) {
    assert.ok(existsSync(file), file);
    assert.ok(options.includeFiles && existsSync(options.includeFiles), `${file} must ship the schema`);
  }
  // The schedule runs a private function that has the schedule trigger and nothing else.
  const tick = config.schedules.tick;
  assert.ok(existsSync(`${tick.function}.ts`));
  assert.deepEqual(config.functions[`${tick.function}.ts`].experimentalTriggers, [{ type: "schedule/v1beta" }]);
  assert.equal(config.functions["api/index.ts"].experimentalTriggers, undefined);
  // The API rewrite comes first, and the dashboard rewrite never takes /api.
  assert.equal(config.rewrites[0].source, "/api/(.*)");
  const last = config.rewrites[config.rewrites.length - 1];
  assert.equal(last.destination, "/index.html");
  assert.match(last.source, /\(\?!api\/\)/);
});
