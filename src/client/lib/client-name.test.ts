import assert from "node:assert/strict";
import { test } from "node:test";
import { joinName, phoneLooksRight, sameName, splitName, tidyPhone } from "./client-name.ts";

test("joinName joins the parts with one space", () => {
  assert.equal(joinName("Jamie", "Rivera"), "Jamie Rivera");
  assert.equal(joinName("  Jamie ", "  Rivera  "), "Jamie Rivera");
  assert.equal(joinName("Mary  Ann", "Smith"), "Mary Ann Smith");
});

test("joinName works with one part only", () => {
  assert.equal(joinName("Jamie", ""), "Jamie");
  assert.equal(joinName("", "Rivera"), "Rivera");
  assert.equal(joinName("  ", " "), "");
});

test("splitName takes the first word as the first name", () => {
  assert.deepEqual(splitName("Jamie Rivera"), { first: "Jamie", last: "Rivera" });
  assert.deepEqual(splitName("Mary Ann Smith"), { first: "Mary", last: "Ann Smith" });
  assert.deepEqual(splitName("  Cher  "), { first: "Cher", last: "" });
  assert.deepEqual(splitName(""), { first: "", last: "" });
});

test("splitName and joinName undo each other", () => {
  for (const name of ["Jamie Rivera", "Cher", "Mary Ann Smith"]) {
    const { first, last } = splitName(name);
    assert.equal(joinName(first, last), name);
  }
});

test("sameName ignores case and extra spaces", () => {
  assert.equal(sameName("jamie  rivera", " Jamie Rivera "), true);
  assert.equal(sameName("Jamie Rivera", "Jamie Rivers"), false);
});

test("phoneLooksRight allows empty, and 10 to 15 digits", () => {
  assert.equal(phoneLooksRight(""), true);
  assert.equal(phoneLooksRight("  "), true);
  assert.equal(phoneLooksRight("(555) 010-1234"), true);
  assert.equal(phoneLooksRight("+1 555 010 1234"), true);
  assert.equal(phoneLooksRight("555-0101"), false);
  assert.equal(phoneLooksRight("1234567890123456"), false);
});

test("tidyPhone gives the stored form of a number", () => {
  assert.equal(tidyPhone("(555) 010-1234"), "+15550101234");
  assert.equal(tidyPhone("+1 555 010 1234"), "+15550101234");
  assert.equal(tidyPhone("+44 20 7946 0958"), "+442079460958");
  assert.equal(tidyPhone("  "), "");
});
