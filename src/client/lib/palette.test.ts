import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_STAFF_COLOR, INK, PAPER, SWATCHES, UNASSIGNED_COLOR } from "./palette.ts";
import { inkOn } from "./calendar-slot.ts";

const HEX = /^#[0-9a-f]{6}$/;

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("every data color is a six-digit lowercase hex code", () => {
  for (const color of [...SWATCHES, UNASSIGNED_COLOR, DEFAULT_STAFF_COLOR, INK, PAPER]) assert.match(color, HEX);
});

test("swatches are all different", () => {
  assert.equal(new Set(SWATCHES).size, SWATCHES.length);
});

test("the default barber color is one of the swatches", () => {
  assert.ok((SWATCHES as readonly string[]).includes(DEFAULT_STAFF_COLOR));
});

test("text on every swatch is easy to read", () => {
  for (const color of [...SWATCHES, UNASSIGNED_COLOR]) {
    const ratio = contrast(color, inkOn(color));
    assert.ok(ratio >= 4.5, `${color} with ${inkOn(color)} is ${ratio.toFixed(2)}:1`);
  }
});

test("inkOn uses the palette's ink and paper", () => {
  assert.equal(inkOn("#ffffff"), INK);
  assert.equal(inkOn("#000000"), PAPER);
});
