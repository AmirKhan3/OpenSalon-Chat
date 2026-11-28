import assert from "node:assert/strict";
import { test } from "node:test";
import { barberChoice, bookSteps, soloBarber } from "./solo.ts";

const marcus = { id: 1, name: "Marcus" };
const dre = { id: 2, name: "Dre" };

test("a shop with one barber has a solo barber", () => {
  assert.equal(soloBarber([marcus]), marcus);
});

test("a shop with no barber or many barbers has none", () => {
  assert.equal(soloBarber([]), null);
  assert.equal(soloBarber([marcus, dre]), null);
  assert.equal(soloBarber(null), null);
  assert.equal(soloBarber(undefined), null);
});

test("a one-barber shop always books that barber", () => {
  assert.equal(barberChoice([marcus], ""), "1");
  assert.equal(barberChoice([marcus], "9"), "1");
});

test("other shops keep the choice on screen", () => {
  assert.equal(barberChoice([marcus, dre], "2"), "2");
  assert.equal(barberChoice([marcus, dre], ""), "");
  assert.equal(barberChoice([], ""), "");
});

test("the booking page skips the barber step for one barber", () => {
  assert.deepEqual(bookSteps(1), ["services", "time", "details"]);
  assert.deepEqual(bookSteps(2), ["services", "barber", "time", "details"]);
});
