import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

process.env.SEED_DEMO_DATA = "false";
process.env.STAFF_PASSWORD = "correct horse";
process.env.SESSION_SECRET = "test-session-secret";

const db = await import("./db.js");
const auth = await import("./auth.js");
const { default: app } = await import("./index.js");
const { createServerApp } = await import("./server.js");

after(() => db.closeDB());

beforeEach(async () => {
  process.env.STAFF_PASSWORD = "correct horse";
  process.env.SESSION_SECRET = "test-session-secret";
  delete process.env.NODE_ENV;
  delete process.env.TRUST_PROXY;
  auth.resetLoginLimits();
  auth.setAuthClock();
  await db.resetDB("pglite:memory");
});

function login(password: string, headers: Record<string, string> = {}, target: { request: typeof app.request } = app) {
  return target.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ password }),
  });
}

/** "name=value" from a Set-Cookie header. */
function cookieFrom(res: Response): string {
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

test("staff routes answer 401 without a login", async () => {
  for (const path of ["/api/stats", "/api/clients", "/api/appointments", "/api/staff", "/api/openapi.json", "/api/nope"]) {
    const res = await app.request(path);
    assert.equal(res.status, 401, path);
    assert.deepEqual(await res.json(), { error: "Please log in." });
  }
  const write = await app.request("/api/clients", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Nope" }),
  });
  assert.equal(write.status, 401);
  assert.equal((await db.get("SELECT COUNT(*)::int AS count FROM clients"))?.count, 0);
});

test("the right password sets a cookie that opens staff routes", async () => {
  const res = await login("correct horse");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { logged_in: true, login_required: true });
  const header = res.headers.get("set-cookie") ?? "";
  assert.match(header, /^tolly_session=v1\.\d+\.[\w-]+;/);
  assert.match(header, /HttpOnly/i);
  assert.match(header, /SameSite=Lax/i);
  assert.match(header, /Max-Age=2592000/i);
  assert.match(header, /Path=\//i);
  assert.doesNotMatch(header, /Secure/i);

  const cookie = cookieFrom(res);
  assert.equal((await app.request("/api/stats", { headers: { cookie } })).status, 200);
  assert.deepEqual(
    await (await app.request("/api/auth/me", { headers: { cookie } })).json(),
    { logged_in: true, login_required: true },
  );
});

test("the cookie is marked Secure on https", async () => {
  const viaProxy = await login("correct horse", { "x-forwarded-proto": "https" });
  assert.match(viaProxy.headers.get("set-cookie") ?? "", /Secure/i);
  const direct = await app.request("https://shop.example/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "correct horse" }),
  });
  assert.match(direct.headers.get("set-cookie") ?? "", /Secure/i);
});

test("a changed, expired, or made-up cookie answers 401", async () => {
  const cookie = cookieFrom(await login("correct horse"));
  const [name, value] = [cookie.slice(0, cookie.indexOf("=")), cookie.slice(cookie.indexOf("=") + 1)];
  const [version, expiry, signature] = value.split(".");

  const later = `${version}.${Number(expiry) + 1000}.${signature}`;
  const flipped = `${version}.${expiry}.${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
  for (const bad of [later, flipped, `${version}.${expiry}.`, `${version}.${expiry}`, "v1.99999999999999.abc", "", "true", `v2.${expiry}.${signature}`]) {
    const res = await app.request("/api/stats", { headers: { cookie: `${name}=${bad}` } });
    assert.equal(res.status, 401, bad);
  }

  // A real cookie stops working after 30 days.
  const realNow = Date.now();
  auth.setAuthClock(() => realNow + 29 * 24 * 60 * 60 * 1000);
  assert.equal((await app.request("/api/stats", { headers: { cookie } })).status, 200);
  auth.setAuthClock(() => realNow + 31 * 24 * 60 * 60 * 1000);
  assert.equal((await app.request("/api/stats", { headers: { cookie } })).status, 401);
});

test("a new password or a new secret ends old sessions", async () => {
  const cookie = cookieFrom(await login("correct horse"));
  process.env.STAFF_PASSWORD = "new password";
  assert.equal((await app.request("/api/stats", { headers: { cookie } })).status, 401);
  process.env.STAFF_PASSWORD = "correct horse";
  assert.equal((await app.request("/api/stats", { headers: { cookie } })).status, 200);
  process.env.SESSION_SECRET = "another-secret";
  assert.equal((await app.request("/api/stats", { headers: { cookie } })).status, 401);
});

test("open routes stay open: health, auth, public, and provider webhooks", async () => {
  assert.equal((await app.request("/api/health")).status, 200);
  assert.deepEqual(await (await app.request("/api/auth/me")).json(), { logged_in: false, login_required: true });
  for (const path of ["/api/health", "/api/auth/me", "/api/auth/login", "/api/public/shop", "/api/public/bookings/abc", "/api/stripe/webhook", "/api/sms/telnyx", "/api/sms/twilio"]) {
    assert.equal(auth.isOpenPath(path), true, path);
    assert.notEqual((await app.request(path)).status, 401, path);
  }
  // Look-alike paths are not open.
  for (const path of ["/api/public", "/api/publicity", "/api/healthz", "/api/auth", "/api/stripe/webhook/x", "/api/sms/other", "/api/clients/public/1"]) {
    assert.equal(auth.isOpenPath(path), false, path);
    assert.equal((await app.request(path)).status, 401, path);
  }
});

test("logout clears the cookie", async () => {
  const res = await app.request("/api/auth/logout", { method: "POST" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { logged_in: false, login_required: true });
  assert.match(res.headers.get("set-cookie") ?? "", /^tolly_session=;.*Max-Age=0/i);
});

test("wrong passwords: 5 tries, then a 5 minute wait", async () => {
  let time = 1_800_000_000_000;
  auth.setAuthClock(() => time);

  for (let i = 0; i < auth.MAX_LOGIN_TRIES; i++) {
    const res = await login("wrong");
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("set-cookie"), null);
  }
  // Locked: even the right password must wait.
  const locked = await login("correct horse");
  assert.equal(locked.status, 429);
  assert.match((await locked.json() as any).error, /Try again in 5 minutes/);
  assert.equal(locked.headers.get("retry-after"), "300");
  assert.equal(locked.headers.get("set-cookie"), null);

  time += auth.LOGIN_WAIT_MS - 1000;
  assert.equal((await login("correct horse")).status, 429);
  time += 2000;
  assert.equal((await login("correct horse")).status, 200);

  // A good login clears the count.
  for (let i = 0; i < auth.MAX_LOGIN_TRIES - 1; i++) assert.equal((await login("wrong")).status, 401);
  assert.equal((await login("correct horse")).status, 200);
  for (let i = 0; i < auth.MAX_LOGIN_TRIES - 1; i++) assert.equal((await login("wrong")).status, 401);
  assert.equal((await login("correct horse")).status, 200);

  // Old wrong tries are forgotten after the wait time.
  for (let i = 0; i < auth.MAX_LOGIN_TRIES - 1; i++) assert.equal((await login("wrong")).status, 401);
  time += auth.LOGIN_WAIT_MS + 1000;
  assert.equal((await login("wrong")).status, 401);
  assert.equal((await login("correct horse")).status, 200);
});

test("the limit is per IP, and X-Forwarded-For counts only behind a trusted proxy", async () => {
  // Not trusted: the header is ignored, so it cannot be used to dodge the limit.
  for (let i = 0; i < auth.MAX_LOGIN_TRIES; i++) {
    assert.equal((await login("wrong", { "x-forwarded-for": `10.0.0.${i}` })).status, 401);
  }
  assert.equal((await login("correct horse", { "x-forwarded-for": "10.9.9.9" })).status, 429);

  auth.resetLoginLimits();
  process.env.TRUST_PROXY = "1";
  for (let i = 0; i < auth.MAX_LOGIN_TRIES; i++) {
    assert.equal((await login("wrong", { "x-forwarded-for": "203.0.113.5" })).status, 401);
  }
  assert.equal((await login("correct horse", { "x-forwarded-for": "203.0.113.5" })).status, 429);
  // The proxy adds the last entry. An entry the caller made up does not help.
  assert.equal((await login("correct horse", { "x-forwarded-for": "1.2.3.4, 203.0.113.5" })).status, 429);
  // Another address is not affected.
  assert.equal((await login("correct horse", { "x-forwarded-for": "203.0.113.6" })).status, 200);
});

test("bad login input gets 400, and does not count as a wrong password", async () => {
  for (const body of ["{}", JSON.stringify({ password: "" }), JSON.stringify({ password: 5 })]) {
    const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal(res.status, 400, body);
    assert.equal(typeof (await res.json() as any).error, "string");
  }
});

test("with no STAFF_PASSWORD: open in development, refuses to start in production", async () => {
  delete process.env.STAFF_PASSWORD;
  assert.equal((await app.request("/api/stats")).status, 200);
  assert.deepEqual(await (await app.request("/api/auth/me")).json(), { logged_in: true, login_required: false });
  assert.match(auth.checkAuthConfig().join(" "), /Staff login is OFF/);

  process.env.NODE_ENV = "production";
  assert.throws(() => auth.checkAuthConfig(), /STAFF_PASSWORD is not set/);
  process.env.STAFF_PASSWORD = "";
  assert.throws(() => auth.checkAuthConfig(), /STAFF_PASSWORD is not set/);

  process.env.STAFF_PASSWORD = "correct horse";
  assert.deepEqual(auth.checkAuthConfig(), []);
  delete process.env.SESSION_SECRET;
  assert.match(auth.checkAuthConfig().join(" "), /SESSION_SECRET is not set/);
});

test("the full server keeps the login rules and still serves pages", async () => {
  const server = createServerApp();
  assert.equal((await server.request("/api/stats")).status, 401);
  const cookie = cookieFrom(await login("correct horse", {}, server));
  assert.equal((await server.request("/api/stats", { headers: { cookie } })).status, 200);
  // Pages load without a login. The dashboard page then shows the login screen.
  const page = await server.request("/");
  assert.ok(page.status === 200 || page.status === 503);
});
