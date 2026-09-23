/**
 * Storage: what is kept, where, and what a UI page is allowed to learn about it.
 *
 * The rule these tests defend is that a credential goes in and never comes back
 * out to a page, and that nothing is ever written to Chrome's syncing storage.
 */

import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

/** A stand-in for chrome.storage.local that behaves the way the real one does. */
function fakeStorageArea() {
  const data = new Map();
  return {
    data,
    async get(key) {
      if (key == null) return Object.fromEntries(data);
      const keys = Array.isArray(key) ? key : [key];
      const out = {};
      for (const k of keys) if (data.has(k)) out[k] = data.get(k);
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, v);
    },
    async remove(key) {
      for (const k of Array.isArray(key) ? key : [key]) data.delete(k);
    },
    async clear() {
      data.clear();
    },
  };
}

const local = fakeStorageArea();

// A `sync` area exists so that any accidental use of it would be silently
// possible -- and then caught by the assertion at the end of this file.
const sync = fakeStorageArea();

globalThis.chrome = { storage: { local, sync } };

const store = await import("../src/lib/store.js");

beforeEach(async () => {
  await local.clear();
  await sync.clear();
});

test("unattended checking is off until it is explicitly asked for", () => {
  // An open tab you are looking at is one thing; traffic with nobody watching
  // is the part that deserves a deliberate yes.
  assert.equal(store.DEFAULT_SETTINGS.notifyWhenClosed, false);
  assert.equal(store.DEFAULT_SETTINGS.pollSeconds, 10);
  assert.equal(
    store.DEFAULT_SETTINGS.backgroundMinutes,
    0,
    "never, until asked for",
  );
});

test("the interval alone decides whether we check in the background", () => {
  // Not gated on wanting notifications: a background check also keeps the
  // toolbar badge current, which is worth having on its own.
  const at = (backgroundMinutes, notifyWhenClosed = false) =>
    store.backgroundPeriodMinutes({ backgroundMinutes, notifyWhenClosed });

  assert.equal(at(1), 1);
  assert.equal(at(5), 5);
  assert.equal(at(60), 60);
  assert.equal(at(5, true), 5, "the notify tick does not change the cadence");

  assert.equal(at(0), 0, "Never means never");
  assert.equal(store.backgroundPeriodMinutes(undefined), 0);
});

test("settings come back merged over the defaults", async () => {
  const defaults = await store.getSettings();
  assert.equal(defaults.pollSeconds, 10);
  assert.equal(defaults.theme, "system");

  await store.setSettings({ pollSeconds: 10 });
  await store.setSettings({ theme: "dark" });

  const merged = await store.getSettings();
  assert.equal(
    merged.pollSeconds,
    10,
    "an earlier patch is not lost by a later one",
  );
  assert.equal(merged.theme, "dark");
  assert.equal(
    merged.notifyStarred,
    true,
    "untouched defaults survive a partial patch",
  );
});

test("a settings key added in a later version defaults rather than reading undefined", async () => {
  // Simulates a profile written by an older build.
  await local.set({ settings: { pollSeconds: 60 } });
  const settings = await store.getSettings();
  assert.equal(settings.pollSeconds, 60);
  assert.equal(
    settings.notifyStarred,
    true,
    "a key the old build never wrote falls back to its default",
  );
  assert.equal(settings.theme, "system");
});

test("starring a pipeline toggles rather than piling up duplicates", async () => {
  assert.deepEqual(await store.getFavorites(), []);
  assert.deepEqual(await store.toggleFavorite("web-app"), ["web-app"]);
  assert.deepEqual(await store.toggleFavorite("api"), ["web-app", "api"]);
  assert.deepEqual(await store.toggleFavorite("web-app"), ["api"]);
  assert.deepEqual(await store.getFavorites(), ["api"]);
});

test("recent pipelines are most-recent-first, de-duplicated and bounded", async () => {
  for (const name of ["a", "b", "c", "a"]) await store.pushRecent(name);
  assert.deepEqual(
    await store.getRecent(),
    ["a", "c", "b"],
    "revisiting moves it to the front",
  );

  for (let i = 0; i < 20; i += 1) await store.pushRecent(`p${i}`);
  const recent = await store.getRecent();
  assert.equal(recent.length, 12, "the list must not grow without bound");
  assert.equal(recent[0], "p19");
});

test("a redacted connection tells a page where it points, never the secret", () => {
  const redacted = store.redactConnection({
    serverUrl: "https://gocd.example.com/go",
    authMode: "token",
    token: "super-secret-token-abcd",
  });

  assert.equal(redacted.serverUrl, "https://gocd.example.com/go");
  assert.equal(redacted.authMode, "token");
  assert.equal(redacted.hasSecret, true);

  const serialised = JSON.stringify(redacted);
  assert.ok(
    !serialised.includes("super-secret-token"),
    `the token leaked: ${serialised}`,
  );
  assert.ok(
    redacted.secretHint.endsWith("abcd"),
    "the last four are kept so two tokens can be told apart",
  );
  assert.ok(redacted.secretHint.length <= 12, "and no more than that");
});

test("a redacted basic connection keeps the username but not the password", () => {
  const redacted = store.redactConnection({
    serverUrl: "https://gocd.example.com/go",
    authMode: "basic",
    username: "karan",
    password: "hunter2-and-then-some",
  });
  assert.equal(redacted.username, "karan");
  assert.ok(!JSON.stringify(redacted).includes("hunter2"));
});

test("session mode stores no secret and says so", () => {
  const redacted = store.redactConnection({
    serverUrl: "https://gocd.example.com/go",
    authMode: "session",
  });
  assert.equal(redacted.hasSecret, false);
  assert.equal(redacted.secretHint, null);
  assert.equal(
    redacted.username,
    undefined,
    "session mode has no username to show",
  );
});

test("redacting nothing yields nothing rather than throwing", () => {
  assert.equal(store.redactConnection(null), null);
});

test("disconnecting drops the credential and the cache but keeps stars", async () => {
  await store.setConnection({
    serverUrl: "https://gocd.example.com/go",
    authMode: "token",
    token: "t",
  });
  await store.setCache({ pipelines: [{ name: "web-app" }], fetchedAt: 1 });
  await store.setSeenStatus({ "web-app": "Failed" });
  await store.toggleFavorite("web-app");

  await store.clearConnection();

  assert.equal(await store.getConnection(), null);
  assert.equal(await store.getCache(), null);
  assert.deepEqual(await store.getSeenStatus(), {});
  assert.deepEqual(
    await store.getFavorites(),
    ["web-app"],
    "stars are the user’s, not the server’s",
  );
});

test("the popup search comes back if you reopen straight away", async () => {
  await store.setPopupSearch("dev11");
  assert.equal(await store.getPopupSearch(), "dev11");

  await store.setPopupSearch("");
  assert.equal(await store.getPopupSearch(), "");
});

test("a popup search older than the TTL is not restored", async () => {
  // A filter left over from yesterday would make the popup answer "is anything
  // red?" about one pipeline while looking like it answered about all of them.
  await store.setPopupSearch("dev11");
  const saved = local.data.get("popupSearch");
  local.data.set("popupSearch", {
    ...saved,
    at: saved.at - store.POPUP_SEARCH_TTL_MS - 1,
  });

  assert.equal(await store.getPopupSearch(), "");
});

test("erasing everything leaves nothing behind", async () => {
  await store.setConnection({
    serverUrl: "https://x/go",
    authMode: "token",
    token: "t",
  });
  await store.setSettings({ pollSeconds: 10 });
  await store.toggleFavorite("web-app");

  await store.wipeEverything();

  assert.equal(local.data.size, 0);
  assert.equal(await store.getConnection(), null);
  assert.deepEqual(await store.getFavorites(), []);
});

test("nothing the store does ever reaches Chrome’s syncing storage", async () => {
  // Everything above ran against the same fake; if any write had gone to the
  // sync area it would have landed here, and that area is uploaded to Google.
  await store.setConnection({
    serverUrl: "https://x/go",
    authMode: "token",
    token: "t",
  });
  await store.setSettings({ theme: "dark" });
  await store.toggleFavorite("web-app");
  await store.setCache({ pipelines: [] });
  await store.pushRecent("web-app");
  await store.setPopupSearch("dev11");

  assert.equal(
    sync.data.size,
    0,
    "a credential must never be synced off this machine",
  );
});

test("re-asserting a search restarts its clock, so the badge keeps seeing it", async () => {
  // The popup shows a restored search in its box and counts against it. If the
  // clock still ran from the original keystroke, the search could expire while
  // it is on screen -- and the badge, which reads through the TTL, would widen
  // to the whole view while the popup narrowed to a handful. Same data, two
  // different answers, which is the one thing the badge must never do.
  await store.setPopupSearch("dev11-live");
  const saved = local.data.get("popupSearch");
  local.data.set("popupSearch", {
    ...saved,
    at: saved.at - store.POPUP_SEARCH_TTL_MS + 500,
  });

  // On the brink: still restored, so the popup would show it.
  assert.equal(await store.getPopupSearch(), "dev11-live");

  // Restoring it re-asserts it, which is what the popup now does on open.
  await store.setPopupSearch("dev11-live");
  local.data.set("popupSearch", {
    ...local.data.get("popupSearch"),
    at: local.data.get("popupSearch").at - store.POPUP_SEARCH_TTL_MS + 500,
  });
  assert.equal(
    await store.getPopupSearch(),
    "dev11-live",
    "the clock runs from the last write, not from the first keystroke",
  );
});
