import assert from "node:assert/strict";
import { after, test } from "node:test";

process.env.SEED_DEMO_DATA = "false";

const db = await import("./db.js");
const { ensureSeeded } = await import("./seed.js");
const { default: app } = await import("./index.js");
const { createServerApp } = await import("./server.js");

after(() => db.closeDB());

test("placeholders are numbered, but not inside strings, identifiers, or comments", () => {
  assert.equal(db.rewritePlaceholders("SELECT * FROM t WHERE a = ? AND b = ?"), "SELECT * FROM t WHERE a = $1 AND b = $2");
  assert.equal(db.rewritePlaceholders("SELECT '?' , ? "), "SELECT '?' , $1 ");
  assert.equal(db.rewritePlaceholders("SELECT 'it''s ?' WHERE x = ?"), "SELECT 'it''s ?' WHERE x = $1");
  assert.equal(db.rewritePlaceholders('SELECT "odd?" FROM t WHERE x = ?'), 'SELECT "odd?" FROM t WHERE x = $1');
  assert.equal(db.rewritePlaceholders("SELECT 1 -- why?\n WHERE x = ?"), "SELECT 1 -- why?\n WHERE x = $1");
  assert.equal(db.rewritePlaceholders("SELECT /* ? */ ?"), "SELECT /* ? */ $1");
  assert.equal(db.rewritePlaceholders("SELECT 'open ?"), "SELECT 'open ?");
});

test("only plain INSERTs get RETURNING id", () => {
  assert.equal(db.withReturningId("INSERT INTO t (a) VALUES (?)"), "INSERT INTO t (a) VALUES (?) RETURNING id");
  assert.equal(db.withReturningId("  insert into t (a) values (?);"), "  insert into t (a) values (?) RETURNING id");
  const upsert = "INSERT INTO _meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value";
  assert.equal(db.withReturningId(upsert), upsert);
  const own = "INSERT INTO t (a) VALUES (?) RETURNING a";
  assert.equal(db.withReturningId(own), own);
  assert.equal(db.withReturningId("UPDATE t SET a = ?"), "UPDATE t SET a = ?");
});

test("run reports the new id and the changed rows; numbers come back as numbers", async () => {
  await db.resetDB("pglite:memory");
  const first = await db.run("INSERT INTO clients (name) VALUES (?)", ["A?B"]);
  const second = await db.run("INSERT INTO clients (name) VALUES (?)", ["C"]);
  assert.equal(first.lastInsertRowid, 1);
  assert.equal(second.lastInsertRowid, 2);
  assert.equal((await db.get("SELECT name FROM clients WHERE id = ?", [1]))?.name, "A?B");
  assert.equal((await db.run("UPDATE clients SET notes = ? WHERE id > ?", ["x", 0])).changes, 2);
  assert.equal((await db.run("DELETE FROM clients WHERE id = ?", [99])).changes, 0);
  const row = await db.get("SELECT COUNT(*) AS big, SUM(1.5::numeric) AS num, utc_now() AS now FROM clients");
  assert.equal(row.big, 2);
  assert.equal(row.num, 3);
  assert.match(row.now, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  // undefined is sent as NULL.
  await db.run("UPDATE clients SET email = ? WHERE id = ?", [undefined, 1]);
  assert.equal((await db.get("SELECT email FROM clients WHERE id = ?", [1]))?.email, null);
});

test("the schema can be applied again and again", async () => {
  await db.resetDB("pglite:memory");
  const { readFileSync } = await import("node:fs");
  const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
  await db.run("INSERT INTO clients (name) VALUES (?)", ["Keep me"]);
  await db.exec(schema);
  await db.exec(schema);
  assert.equal((await db.get("SELECT COUNT(*)::int AS count FROM clients"))?.count, 1);
});

test("sample data goes only into empty tables, and can be turned off", async () => {
  await db.resetDB("pglite:memory");
  process.env.SEED_DEMO_DATA = "false";
  await ensureSeeded();
  assert.equal((await db.get("SELECT COUNT(*)::int AS count FROM staff"))?.count, 0);
  assert.equal((await db.get("SELECT value FROM _meta WHERE key = 'appointment_prefix'"))?.value, "APT");

  await db.resetDB("pglite:memory");
  process.env.SEED_DEMO_DATA = "true";
  try {
    await db.run("INSERT INTO clients (name) VALUES (?)", ["Already here"]);
    await ensureSeeded();
    assert.equal((await db.get("SELECT COUNT(*)::int AS count FROM staff"))?.count, 1);
    assert.equal((await db.get("SELECT COUNT(*)::int AS count FROM services"))?.count, 6);
    // The clients table was not empty, so it is left alone.
    assert.equal((await db.get("SELECT COUNT(*)::int AS count FROM clients"))?.count, 1);
    // New rows get ids after the sample rows.
    assert.equal((await db.run("INSERT INTO staff (name) VALUES (?)", ["New barber"])).lastInsertRowid, 2);
    assert.equal((await db.run("INSERT INTO services (name) VALUES (?)", ["New service"])).lastInsertRowid, 7);
  } finally {
    process.env.SEED_DEMO_DATA = "false";
  }
});

test("example chats are added only when asked for, once, and show the hand-off", async () => {
  process.env.SEED_DEMO_DATA = "true";
  try {
    // Off by default: sample data alone adds no chats.
    await db.resetDB("pglite:memory");
    await ensureSeeded();
    assert.equal((await db.get("SELECT COUNT(*)::int AS count FROM chat_threads"))?.count, 0);

    await db.resetDB("pglite:memory");
    process.env.SEED_DEMO_CHATS = "true";
    await ensureSeeded();
    const list = await (await app.request("/api/chat/threads")).json() as any;
    assert.equal(list.threads.length, 3);
    assert.equal(list.needs_attention, 1);
    // The chat that needs the barber is the newest, so it is on top.
    const top = list.threads[0];
    assert.equal(top.display_name, "Tony Russo");
    assert.equal(top.needs_attention, true);
    assert.equal(top.mode, "human");
    assert.equal(top.staff_unread, 2);
    assert.equal(top.client_id, 2);
    // No phone number: a reply can never go out as a text.
    assert.ok(list.threads.every((t: any) => t.channel === "web" && t.phone === null));

    const detail = await (await app.request(`/api/chat/threads/${top.id}`)).json() as any;
    assert.ok(detail.messages.some((m: any) => m.sender === "note"));
    assert.ok(detail.messages.some((m: any) => m.sender === "agent" && m.body.endsWith("- Tolly")));
    assert.ok(detail.messages.every((m: any) => !m.body.includes("{name}")));
    assert.match(detail.messages[0].created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    // A second start adds nothing.
    await db.resetDB("pglite:memory");
    const kept = await db.run("INSERT INTO chat_threads (kind, channel) VALUES ('client', 'web')");
    await ensureSeeded();
    assert.equal((await db.get("SELECT COUNT(*)::int AS count FROM chat_threads WHERE kind = 'client'"))?.count, 1);
    assert.ok(kept.lastInsertRowid);
  } finally {
    process.env.SEED_DEMO_DATA = "false";
    delete process.env.SEED_DEMO_CHATS;
  }
});

test("bad input gets 400 { error }, unknown API paths get 404, health is open", async () => {
  await db.resetDB("pglite:memory");
  const bad = await app.request("/api/clients", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
  });
  assert.equal(bad.status, 400);
  assert.equal(typeof (await bad.json() as any).error, "string");
  const notNumber = await app.request("/api/clients/abc");
  assert.equal(notNumber.status, 400);
  assert.equal(typeof (await notNumber.json() as any).error, "string");
  assert.equal((await app.request("/api/nope")).status, 404);
  assert.deepEqual(await (await app.request("/api/health")).json(), { ok: true });
  const doc = await (await app.request("/api/openapi.json")).json() as any;
  assert.equal(doc.info.title, "Tolly");
});

test("search ignores letter case", async () => {
  await db.resetDB("pglite:memory");
  await db.run("INSERT INTO clients (name) VALUES (?)", ["Jamal Carter"]);
  const res = await (await app.request("/api/clients?search=jAMAL")).json() as any;
  assert.equal(res.total, 1);
  assert.equal(res.clients[0].name, "Jamal Carter");
});

test("the server sends the API, pages, and only extension paths to static files", async () => {
  await db.resetDB("pglite:memory");
  const server = createServerApp();
  assert.deepEqual(await (await server.request("/api/health")).json(), { ok: true });
  assert.equal((await server.request("/api/nope")).status, 404);
  // A missing file is a 404, not the dashboard page.
  assert.equal((await server.request("/assets/missing-file.js")).status, 404);
  assert.equal((await server.request("/../package.json")).status, 404);
  // Page routes answer with HTML (or a "not built" page when dist/ is missing).
  for (const path of ["/", "/clients", "/book", "/book/manage/abc"]) {
    const res = await server.request(path);
    assert.ok(res.status === 200 || res.status === 503, `${path} -> ${res.status}`);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  }
});

// ── The booking lock (Postgres) ────────────────────────────────────

function fakeLockClient(failOn?: string) {
  const log: string[] = [];
  const client: import("./db.js").LockClient = {
    async query(sql) {
      const word = sql.startsWith("SELECT pg_advisory_xact_lock") ? "LOCK" : sql;
      log.push(word);
      if (word === failOn) throw new Error(`${word} failed`);
    },
    release(destroy) {
      log.push(destroy ? "destroy" : "release");
    },
  };
  return { log, connect: async () => client };
}

test("the booking lock wraps the task in one transaction", async () => {
  const { log, connect } = fakeLockClient();
  const result = await db.runLocked(connect, async () => { log.push("task"); return 42; });
  assert.equal(result, 42);
  assert.deepEqual(log, ["BEGIN", "LOCK", "task", "COMMIT", "release"]);
});

test("the booking lock is given back when the task fails", async () => {
  const { log, connect } = fakeLockClient();
  await assert.rejects(db.runLocked(connect, async () => { log.push("task"); throw new Error("no"); }), /no/);
  assert.deepEqual(log, ["BEGIN", "LOCK", "task", "COMMIT", "release"]);
});

test("the task does not run when the lock cannot be taken, and the connection is thrown away", async () => {
  const { log, connect } = fakeLockClient("LOCK");
  await assert.rejects(db.runLocked(connect, async () => { log.push("task"); }), /LOCK failed/);
  assert.deepEqual(log, ["BEGIN", "LOCK", "destroy"]);
});

test("a lost lock connection does not hide the task's result", async () => {
  const { log, connect } = fakeLockClient("COMMIT");
  assert.equal(await db.runLocked(connect, async () => "done"), "done");
  assert.deepEqual(log, ["BEGIN", "LOCK", "COMMIT", "destroy"]);
});

test("with the embedded database, a locked task just runs", async () => {
  await db.resetDB("pglite:memory");
  assert.equal(await db.withDbLock(async () => "ok"), "ok");
});

test("on Vercel the server refuses to start without a Postgres database", async () => {
  await db.closeDB();
  process.env.VERCEL = "1";
  try {
    await assert.rejects(db.initDB(""), /DATABASE_URL is not set/);
  } finally {
    delete process.env.VERCEL;
    await db.resetDB("pglite:memory");
  }
});
