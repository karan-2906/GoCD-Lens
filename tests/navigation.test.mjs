/**
 * Where the back button goes.
 *
 * A pipeline page can open another pipeline -- the run that triggered this one
 * -- so "back" is not always the list. It has to be the pipeline you came from,
 * or walking a chain of upstream runs is a one-way trip and the way out is to
 * start again from the list.
 *
 * The other half of it is the stale trail: every path that drops you back on
 * the list has to forget the trail, or a back press later lands on a pipeline
 * you left several screens ago.
 */

import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// state.js pulls in ui.js, which touches the DOM only inside functions.
// `navigate` asks for `.content` to scroll it; a null answer is a valid one.
globalThis.document = {
  createElement: () => ({
    className: "",
    dataset: {},
    style: {},
    append() {},
    setAttribute() {},
    addEventListener() {},
  }),
  createTextNode: (t) => ({ textContent: String(t) }),
  createDocumentFragment: () => ({ append() {} }),
  createElementNS: () => ({ setAttribute() {}, append() {} }),
  querySelector: () => null,
};
globalThis.Node = class {};

globalThis.chrome = {
  runtime: {
    sendMessage: async () => ({
      ok: true,
      data: { groups: [], pipelines: [], view: null },
    }),
  },
};

const { state, navigate, goBack, backTarget, resetToList, selectView } =
  await import("../src/dashboard/state.js");

const list = { kind: "list" };
const open = (name) => navigate({ kind: "pipeline", name });

beforeEach(() => {
  state.pipelines = [];
  state.groups = [];
  state.activeView = null;
  state.search = "";
  navigate(list); // also empties the trail
});

test("back from a pipeline opened off the list goes to the list", () => {
  open("web-app-deploy");
  goBack();
  assert.deepEqual(state.route, list);
});

test("back from a pipeline opened off another pipeline goes to that one", () => {
  open("web-app-deploy");
  open("web-app-build-prod"); // "Triggered by ... - open that pipeline"
  goBack();
  assert.deepEqual(state.route, { kind: "pipeline", name: "web-app-deploy" });
});

test("a chain is retraced one hop at a time, ending at the list", () => {
  open("deploy");
  open("test");
  open("build");

  goBack();
  assert.deepEqual(state.route, { kind: "pipeline", name: "test" });
  goBack();
  assert.deepEqual(state.route, { kind: "pipeline", name: "deploy" });
  goBack();
  assert.deepEqual(state.route, list);
});

test("the button can name where it goes, and says nothing when that is the list", () => {
  open("deploy");
  assert.equal(backTarget(), null);
  open("build");
  assert.equal(backTarget(), "deploy");
  goBack();
  assert.equal(backTarget(), null);
});

test("landing on the list forgets the trail", () => {
  open("deploy");
  open("build");
  navigate(list);
  open("payments-nightly");

  goBack();
  assert.deepEqual(state.route, list, "back must not reach behind the list");
});

// Typing in the search box and pressing a filter chip both drop you back on the
// list mid-update, without going through `navigate`. Assigning `state.route`
// there used to leave the trail standing.
test("a reset to the list forgets the trail too", () => {
  open("deploy");
  open("build");
  resetToList();
  open("payments-nightly");

  goBack();
  assert.deepEqual(state.route, list);
});

test("picking a view forgets the trail", async () => {
  open("deploy");
  open("build");
  await selectView("Visual Builder");
  open("payments-nightly");

  goBack();
  assert.deepEqual(state.route, list);
});

test("reopening the pipeline already on screen does not stack it on itself", () => {
  open("deploy");
  open("deploy");

  goBack();
  assert.deepEqual(
    state.route,
    list,
    "back would otherwise land where it started",
  );
});

// A triggered B triggered A ... is a chain you can walk in circles, and an
// unbounded trail would mean back never reaches the list again.
test("a long chain still terminates at the list", () => {
  for (let i = 0; i < 40; i += 1) open(`pipeline-${i % 2}`);

  for (let i = 0; i < 40; i += 1) goBack();
  assert.deepEqual(state.route, list);
});

// These tests reach the routing but not the button, so assert the wiring: the
// pipeline page must own no route to the list that steps over the trail. This
// is the exact shape the bug had -- a back button hardcoded to the list.
test("the pipeline page has no hardcoded route back to the list", async () => {
  const src = await readFile(
    new URL("../src/dashboard/pipeline-view.js", import.meta.url),
    "utf8",
  );
  assert.ok(
    !/navigate\(\{\s*kind:\s*['"]list['"]/.test(src),
    "back on this screen goes through goBack()",
  );
});
