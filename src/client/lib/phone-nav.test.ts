import assert from "node:assert/strict";
import { test } from "node:test";
import { backFor, PHONE_TABS, PROFILE_GROUPS, screenFor, startsNewMoment, tabFor } from "./phone-nav.ts";
import { parseRoute } from "../hooks/use-router.ts";

test("the tabs are the assistant, the calendar, the inbox and the profile", () => {
  assert.deepEqual(PHONE_TABS.map((t) => t.key), ["agent", "calendar", "inbox", "profile"]);
  assert.equal(PHONE_TABS[3].path, "/profile");
  assert.equal(PHONE_TABS[0].path, "/assistant");
  assert.equal(PHONE_TABS[1].path, "/calendar");
});

test("a phone opens on the assistant, a wide screen on the dashboard", () => {
  assert.equal(screenFor("dashboard", true, true), "assistant");
  assert.equal(screenFor("dashboard", true, false), "dashboard");
});

test("a phone can still open the dashboard at /dashboard", () => {
  assert.equal(screenFor("dashboard", false, true), "dashboard");
});

test("other screens are the same on every size", () => {
  for (const isPhone of [true, false]) {
    assert.equal(screenFor("calendar", false, isPhone), "calendar");
    assert.equal(screenFor("inbox", false, isPhone), "inbox");
    assert.equal(screenFor("assistant", false, isPhone), "assistant");
  }
});

test("each screen lights up the right tab", () => {
  assert.equal(tabFor("assistant"), "agent");
  assert.equal(tabFor("calendar"), "calendar");
  assert.equal(tabFor("inbox"), "inbox");
  for (const view of ["clients", "dashboard", "profile", "automations", "appointments", "staff", "services", "products", "reports", "settings"] as const) {
    assert.equal(tabFor(view), "profile");
  }
});

test("the profile screen links to every screen that has no tab, once each", () => {
  const items = PROFILE_GROUPS.flat();
  assert.deepEqual(
    items.map((i) => i.view).sort(),
    ["appointments", "automations", "clients", "dashboard", "products", "reports", "services", "staff"],
  );
  for (const item of items) {
    assert.equal(parseRoute(item.path).view, item.view);
    assert.equal(tabFor(item.view), "profile");
  }
  // Settings has its own button at the top of the profile screen.
  assert.equal(items.some((i) => i.view === "settings"), false);
});

test("pages opened from the profile screen go back to it", () => {
  for (const view of ["clients", "dashboard", "automations", "appointments", "staff", "services", "products", "reports", "settings"] as const) {
    assert.deepEqual(backFor(view, false), { path: "/profile", label: "Profile" });
  }
  // Tab screens have no back link, and neither do detail pages, which have their own.
  for (const view of ["profile", "assistant", "calendar", "inbox"] as const) assert.equal(backFor(view, false), null);
  assert.equal(backFor("clients", true), null);
});

test("the old /more address opens the profile screen", () => {
  assert.equal(parseRoute("/more").view, "profile");
  assert.equal(parseRoute("/profile").view, "profile");
});

test("the route knows when the address is the home address", () => {
  assert.deepEqual(parseRoute("/"), { view: "dashboard", id: null, home: true });
  assert.deepEqual(parseRoute(""), { view: "dashboard", id: null, home: true });
  assert.deepEqual(parseRoute("/dashboard"), { view: "dashboard", id: null, home: false });
  assert.deepEqual(parseRoute("/inbox/7"), { view: "inbox", id: "7", home: false });
  // An unknown address shows the dashboard, but it is not the home address.
  assert.deepEqual(parseRoute("/nope"), { view: "dashboard", id: null, home: false });
});

test("a chat shows the time on the first message and after a gap", () => {
  assert.equal(startsNewMoment(undefined, "2026-03-01 10:00:00"), true);
  assert.equal(startsNewMoment("2026-03-01 10:00:00", "2026-03-01 10:05:00"), false);
  assert.equal(startsNewMoment("2026-03-01 10:00:00", "2026-03-01 10:15:00"), true);
  assert.equal(startsNewMoment("2026-03-01T10:00:00Z", "2026-03-02T09:00:00Z"), true);
});

test("a message with no time never shows one", () => {
  assert.equal(startsNewMoment("2026-03-01 10:00:00", null), false);
  assert.equal(startsNewMoment(null, "not a time"), false);
});
