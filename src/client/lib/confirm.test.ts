import { test } from "node:test";
import assert from "node:assert/strict";
import { filterThreads, staffDeleteWords, typedMatches } from "./confirm.ts";

test("typedMatches: the name must match, but case and outer spaces do not matter", () => {
  assert.equal(typedMatches("  marcus ", "Marcus"), true);
  assert.equal(typedMatches("Marc", "Marcus"), false);
  assert.equal(typedMatches("", "Marcus"), false);
  assert.equal(typedMatches("", ""), false);
  assert.equal(typedMatches("   ", "  "), false);
});

test("staffDeleteWords: a barber with bookings can only be deactivated", () => {
  const one = staffDeleteWords("Marcus", 1, false);
  assert.equal(one.blocked, true);
  assert.equal(one.action, "Deactivate Marcus");
  assert.equal(one.typeToConfirm, undefined);
  assert.match(one.text, /1 booking\./);
  assert.match(staffDeleteWords("Marcus", 634, false).text, /634 bookings\./);
});

test("staffDeleteWords: the only barber cannot be deleted", () => {
  const words = staffDeleteWords("Marcus", 0, true);
  assert.equal(words.blocked, true);
  assert.equal(words.action, "OK");
});

test("staffDeleteWords: an unused barber needs their name typed", () => {
  const words = staffDeleteWords("Dee", 0, false);
  assert.equal(words.blocked, undefined);
  assert.equal(words.typeToConfirm, "Dee");
  assert.equal(words.action, "Delete Dee");
});

const threads = [
  { display_name: "Andre Cole", phone: "+1 (555) 010-2233", preview: "Can I move to Friday?", needs_attention: true },
  { display_name: "Web visitor", phone: null, preview: "What are your prices?", needs_attention: false },
  { display_name: "Sam Ortiz", phone: "+15550104455", preview: "Thanks!", needs_attention: false },
];

test("filterThreads: no words and no filter keeps every chat", () => {
  assert.equal(filterThreads(threads, "  ", false).length, 3);
});

test("filterThreads: finds a chat by name, message or phone number", () => {
  assert.deepEqual(filterThreads(threads, "ORTIZ", false).map((t) => t.display_name), ["Sam Ortiz"]);
  assert.deepEqual(filterThreads(threads, "prices", false).map((t) => t.display_name), ["Web visitor"]);
  assert.deepEqual(filterThreads(threads, "555-010-22", false).map((t) => t.display_name), ["Andre Cole"]);
  assert.equal(filterThreads(threads, "zzz", false).length, 0);
});

test("filterThreads: one or two digits do not match every phone number", () => {
  assert.equal(filterThreads(threads, "55", false).length, 0);
});

test("filterThreads: the filter keeps only chats that need the barber", () => {
  assert.deepEqual(filterThreads(threads, "", true).map((t) => t.display_name), ["Andre Cole"]);
  assert.equal(filterThreads(threads, "ortiz", true).length, 0);
});

test("typedMatches: a run of spaces in the name counts as one space", () => {
  assert.equal(typedMatches("mary ann", "Mary  Ann"), true);
  assert.equal(typedMatches("mary   ann", "Mary Ann"), true);
  assert.equal(typedMatches("maryann", "Mary  Ann"), false);
});
