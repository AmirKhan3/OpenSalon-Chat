import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

process.env.SEED_DEMO_DATA = "false";
process.env.STAFF_PASSWORD = "";

const { default: app } = await import("./index.js");
const dbm = await import("./db.js");
const { likeText, suggestClients } = await import("./clientsuggest.js");

after(() => dbm.closeDB());

type Suggestion = { id: number; name: string; phone: string };

async function suggest(q?: string): Promise<Suggestion[]> {
  const res = await app.request(`/api/clients/suggest${q === undefined ? "" : `?q=${encodeURIComponent(q)}`}`);
  assert.equal(res.status, 200);
  return ((await res.json()) as { clients: Suggestion[] }).clients;
}

beforeEach(async () => {
  await dbm.resetDB("pglite:memory");
  // Five customers, oldest first. Ana has the newest booking, then Jamie.
  await dbm.exec(`
    INSERT INTO clients (id, name, phone, created_at) VALUES
      (1, 'Jamie Rivera', '+15550100001', '2026-01-01 10:00:00'),
      (2, 'Ana Lopez', '+15550100002', '2026-01-02 10:00:00'),
      (3, 'James Carter', NULL, '2026-01-03 10:00:00'),
      (4, 'Mary Ann Jameson', '+15550100004', '2026-01-04 10:00:00'),
      (5, '100% Dan_o', '', '2026-01-05 10:00:00');
    INSERT INTO appointments (identifier, client_id, scheduled_date, start_time, end_time, created_at) VALUES
      ('A-1', 1, '2026-03-01', '10:00', '10:30', '2026-02-10 09:00:00'),
      ('A-2', 2, '2026-03-02', '10:00', '10:30', '2026-02-11 09:00:00'),
      ('A-3', 1, '2026-01-05', '10:00', '10:30', '2026-01-01 11:00:00');
  `);
});

test("with no text it gives the 3 most recent customers", async () => {
  const names = (await suggest()).map((c) => c.name);
  // Newest booking first, then the customer added last.
  assert.deepEqual(names, ["Ana Lopez", "Jamie Rivera", "100% Dan_o"]);
  assert.deepEqual((await suggest("   ")).map((c) => c.name), names);
});

test("it never gives more than 3", async () => {
  assert.equal((await suggest()).length, 3);
  assert.equal((await suggestClients("", 99)).length, 5);
  assert.equal((await suggestClients("", 0)).length, 3);
});

test("it matches the start of a first name, any case", async () => {
  assert.deepEqual((await suggest("jam")).map((c) => c.name), ["Jamie Rivera", "Mary Ann Jameson", "James Carter"]);
  assert.deepEqual((await suggest("JAMIE")).map((c) => c.name), ["Jamie Rivera"]);
});

test("it matches the start of a last name and a full name", async () => {
  assert.deepEqual((await suggest("lop")).map((c) => c.name), ["Ana Lopez"]);
  assert.deepEqual((await suggest("jamie  riv")).map((c) => c.name), ["Jamie Rivera"]);
});

test("it does not match the middle of a word", async () => {
  assert.deepEqual(await suggest("ivera"), []);
  assert.deepEqual(await suggest("zzz"), []);
});

test("it gives the id, the name and the phone only", async () => {
  const [jamie] = await suggest("jamie");
  assert.deepEqual(jamie, { id: 1, name: "Jamie Rivera", phone: "+15550100001" });
  // A customer with no phone gets an empty text, not null.
  const james = (await suggest("james c"))[0];
  assert.deepEqual(james, { id: 3, name: "James Carter", phone: "" });
});

test("%, _ and \\ are plain text, not wildcards", async () => {
  assert.equal(likeText("50%_\\"), "50\\%\\_\\\\");
  assert.deepEqual(await suggest("%"), []);
  assert.deepEqual(await suggest("_"), []);
  assert.deepEqual((await suggest("100%")).map((c) => c.name), ["100% Dan_o"]);
  assert.deepEqual((await suggest("dan_")).map((c) => c.name), ["100% Dan_o"]);
  assert.deepEqual(await suggest("danx"), []);
});

test("a quote in the name is safe", async () => {
  await dbm.exec(`INSERT INTO clients (id, name) VALUES (6, 'Pat O''Brien')`);
  assert.deepEqual((await suggest("o'br")).map((c) => c.name), ["Pat O'Brien"]);
  assert.deepEqual(await suggest("'; DROP TABLE clients; --"), []);
  assert.equal((await suggest()).length, 3);
});

test("the path is not read as a client id", async () => {
  const res = await app.request("/api/clients/suggest");
  assert.equal(res.status, 200);
});

test("exact=1 gives only customers with that whole name", async () => {
  const exact = async (q: string) => {
    const res = await app.request(`/api/clients/suggest?exact=1&q=${encodeURIComponent(q)}`);
    assert.equal(res.status, 200);
    return ((await res.json()) as { clients: Suggestion[] }).clients.map((c) => c.name);
  };
  // Three newer customers start with the same text. The older one is still found.
  await dbm.exec(`INSERT INTO clients (id, name, created_at) VALUES
    (6, 'Ana Lopez Jr', '2026-03-01 10:00:00'),
    (7, 'Ana Lopez-Smith', '2026-03-02 10:00:00'),
    (8, 'Ana Lopezina', '2026-03-03 10:00:00'),
    (9, 'Sam   Odd  Spaces', '2026-03-04 10:00:00')`);
  assert.deepEqual(await exact("ana  LOPEZ "), ["Ana Lopez"]);
  assert.deepEqual(await exact("Sam Odd Spaces"), ["Sam   Odd  Spaces"]);
  assert.deepEqual(await exact("Ana"), []);
  assert.deepEqual(await exact("%"), []);
  assert.deepEqual(await exact(""), []);
});

test("a very long text is refused", async () => {
  const res = await app.request(`/api/clients/suggest?q=${"a".repeat(201)}`);
  assert.equal(res.status, 400);
});
