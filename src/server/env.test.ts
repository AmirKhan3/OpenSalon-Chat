import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isServerEntry, loadEnv } from "./env.js";

test("loadEnv reads a file, and a variable that is already set wins", () => {
  const dir = mkdtempSync(join(tmpdir(), "tolly-env-"));
  const file = join(dir, ".env");
  writeFileSync(file, "# a comment\nTOLLY_TEST_NEW=from-file\nTOLLY_TEST_SET=from-file\nTOLLY_TEST_EMPTY=\n");
  process.env.TOLLY_TEST_SET = "from-shell";
  try {
    assert.equal(loadEnv(file), true);
    assert.equal(process.env.TOLLY_TEST_NEW, "from-file");
    assert.equal(process.env.TOLLY_TEST_SET, "from-shell");
    assert.equal(process.env.TOLLY_TEST_EMPTY, "");
  } finally {
    delete process.env.TOLLY_TEST_NEW;
    delete process.env.TOLLY_TEST_SET;
    delete process.env.TOLLY_TEST_EMPTY;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadEnv returns false when there is no file", () => {
  assert.equal(loadEnv(join(tmpdir(), "tolly-no-such-dir", ".env")), false);
});

test("the .env file is loaded only when the server is the entry point", () => {
  assert.equal(isServerEntry("/app/src/server/server.ts"), true);
  assert.equal(isServerEntry("src/server/server.ts"), true);
  assert.equal(isServerEntry("C:\\app\\src\\server\\server.js"), true);
  assert.equal(isServerEntry("server.ts"), true);
  assert.equal(isServerEntry("/app/src/server/server.test.ts"), false);
  assert.equal(isServerEntry("/app/src/server/myserver.ts"), false);
  assert.equal(isServerEntry(undefined), false);
});
