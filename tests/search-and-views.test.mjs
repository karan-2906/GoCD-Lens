/**
 * What is on screen: the search box, the filter chips, the selected group and
 * the selected GoCD view, all resolved by one function.
 *
 * `matchingPipelines()` decides what the list renders *and* what "save this as
 * a GoCD view" saves, so a disagreement between those two would be a silent way
 * to save the wrong thing.
 */

import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

// state.js pulls in ui.js, which touches the DOM only inside functions -- but
// `el` is called at module scope by nothing, so a bare stub is enough.
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

// `selectView` refreshes through the service worker. Nothing here cares what
// comes back, only that the state around it was reset before it was asked.
globalThis.chrome = {
  runtime: {
    sendMessage: async () => ({
      ok: true,
      data: { groups: [], pipelines: [], view: null },
    }),
  },
};

const {
  state,
  matchingPipelines,
  counts,
  passesFilter,
  visibleGroups,
  rememberedNames,
  selectView,
} = await import("../src/dashboard/state.js");

function pipeline(name, status, { paused = false } = {}) {
  return {
    name,
    pause_info: { paused },
    _embedded: {
      instances: [
        {
          counter: 1,
          label: "1",
          _embedded: { stages: [{ name: "build", status }] },
        },
      ],
    },
  };
}

beforeEach(() => {
  state.pipelines = [
    pipeline("web-app-build-prod", "Passed"),
    pipeline("web-app-deploy", "Failed"),
    pipeline("api-build-test", "Building"),
    pipeline("payments-nightly", "Passed", { paused: true }),
  ];
  state.groups = [
    { name: "core", pipelines: ["web-app-build-prod", "web-app-deploy"] },
    { name: "platform", pipelines: ["api-build-test", "payments-nightly"] },
  ];
  state.favorites = [];
  state.watched = [];
  state.loadError = null;
  state.search = "";
  state.filter = "all";
  state.group = null;
  state.groupSearch = "";
  state.activeView = null;
  state.route = { kind: "list" };
});

const names = () => matchingPipelines().map((m) => m.pipeline.name);

// --------------------------------------------------------------- searching

test("with no search, everything is listed worst-first", () => {
  // Red before running before green, so the thing that needs you is at the top.
  assert.deepEqual(names(), [
    "web-app-deploy",
    "api-build-test",
    "payments-nightly",
    "web-app-build-prod",
  ]);
});

test("typing a few letters finds a pipeline by initials", () => {
  state.search = "wabp";
  assert.deepEqual(names(), ["web-app-build-prod"]);
});

test("a substring wins over a scattered match", () => {
  state.search = "deploy";
  assert.equal(names()[0], "web-app-deploy");
});

test("searching a group name finds everything in that group", () => {
  // Typing `platform` should not come back empty just because no pipeline is
  // called that.
  state.search = "platform";
  assert.deepEqual(names().sort(), ["api-build-test", "payments-nightly"]);
});

test("a group match is marked as such, and never outranks a name match", () => {
  state.groups = [
    { name: "api", pipelines: ["payments-nightly"] },
    { name: "core", pipelines: ["api-build-test"] },
  ];
  state.search = "api";

  const matches = matchingPipelines();
  assert.equal(
    matches[0].pipeline.name,
    "api-build-test",
    "the name match comes first",
  );
  assert.equal(matches[0].viaGroup, null);

  const viaGroup = matches.find((m) => m.pipeline.name === "payments-nightly");
  assert.equal(
    viaGroup.viaGroup,
    "api",
    "and the group match is labelled so the row makes sense",
  );
});

test("search reports which characters matched, for highlighting", () => {
  state.search = "wabp";
  const [match] = matchingPipelines();
  assert.deepEqual(match.hits, [0, 4, 8, 14]);
  const matched = match.hits.map((i) => match.pipeline.name[i]).join("");
  assert.equal(matched, "wabp");
});

test("a search that matches nothing returns nothing rather than everything", () => {
  state.search = "zzzzz";
  assert.deepEqual(names(), []);
});

test("whitespace alone is not a search", () => {
  state.search = "   ";
  assert.equal(names().length, 4);
});

// ---------------------------------------------------------------- filtering

test("the filter chips narrow to the state they name", () => {
  state.filter = "failing";
  assert.deepEqual(names(), ["web-app-deploy"]);

  state.filter = "building";
  assert.deepEqual(names(), ["api-build-test"]);

  state.filter = "paused";
  assert.deepEqual(names(), ["payments-nightly"]);
});

test("the starred filter follows the stars", () => {
  state.filter = "favorites";
  assert.deepEqual(names(), []);
  state.favorites = ["api-build-test"];
  assert.deepEqual(names(), ["api-build-test"]);
});

test("a selected group narrows the list, and search narrows it further", () => {
  state.group = "core";
  assert.deepEqual(names().sort(), ["web-app-build-prod", "web-app-deploy"]);

  state.search = "deploy";
  assert.deepEqual(names(), ["web-app-deploy"]);
});

test("search, filter and group compose rather than overriding each other", () => {
  state.group = "core";
  state.filter = "failing";
  state.search = "web";
  assert.deepEqual(names(), ["web-app-deploy"]);
});

test("the chip counts describe the whole server, not the filtered view", () => {
  // Otherwise clicking "Failing" would reset its own count to itself.
  state.filter = "failing";
  state.group = "core";
  const totals = counts();
  assert.equal(totals.all, 4);
  assert.equal(totals.failing, 1);
  assert.equal(totals.building, 1);
  assert.equal(totals.paused, 1);
});

test("passesFilter is the single rule the counts and the list share", () => {
  state.filter = "failing";
  const failing = state.pipelines.filter(passesFilter).map((p) => p.name);
  assert.deepEqual(failing, ["web-app-deploy"]);
});

// -------------------------------------------------------------------- views

test("a pipeline outside the active view is simply not in the payload", () => {
  // GoCD filters by viewName server-side, so selecting a view means the
  // extension is handed fewer pipelines rather than hiding some locally.
  state.activeView = "Mine";
  state.pipelines = [pipeline("web-app-deploy", "Failed")];
  state.groups = [{ name: "core", pipelines: ["web-app-deploy"] }];
  assert.deepEqual(names(), ["web-app-deploy"]);
  assert.equal(counts().all, 1);
});

test("the search box and the filter chips narrow the same one list", () => {
  state.search = "web";
  state.filter = "all";
  assert.deepEqual(names().sort(), ["web-app-build-prod", "web-app-deploy"]);

  state.filter = "failing";
  assert.deepEqual(
    names(),
    ["web-app-deploy"],
    "they stack rather than replacing each other",
  );
});

test("a group with no visible members does not strand the list", () => {
  state.groups.push({ name: "empty", pipelines: ["gone-pipeline"] });
  state.group = "empty";
  assert.deepEqual(names(), []);
});

// ------------------------------------------------------------ group sidebar

test("the sidebar lists only groups that still have a pipeline in them", () => {
  state.groups.push({ name: "decommissioned", pipelines: ["gone-pipeline"] });
  assert.deepEqual(
    visibleGroups().map((g) => g.name),
    ["core", "platform"],
    "a group whose pipelines are all outside the view is not worth a row",
  );
});

test("the sidebar filter matches a group by subsequence, best hit first", () => {
  state.groups.push({ name: "platform-tools", pipelines: ["web-app-deploy"] });

  state.groupSearch = "plat";
  assert.deepEqual(
    visibleGroups().map((g) => g.name),
    ["platform", "platform-tools"],
  );

  state.groupSearch = "pfm";
  assert.deepEqual(
    visibleGroups().map((g) => g.name),
    ["platform", "platform-tools"],
    "scattered letters still find it, the way the pipeline search does",
  );

  state.groupSearch = "zzz";
  assert.deepEqual(visibleGroups(), []);
});

test("the sidebar filter does not touch which pipelines the list shows", () => {
  state.groupSearch = "core";
  assert.equal(
    matchingPipelines().length,
    4,
    "it narrows the sidebar and nothing else",
  );
});

test("a search typed against the list follows you into the new view", () => {
  state.search = "web";
  state.groupSearch = "core";
  state.group = "core";
  state.route = { kind: "list" };

  const done = selectView("Mine");

  assert.equal(state.search, "web", "a filter you typed is one you still want");
  assert.equal(state.groupSearch, "core", "the sidebar box only ever filters");
  assert.equal(
    state.group,
    null,
    "but a group chosen in the old view may not be in this one",
  );
  assert.deepEqual(state.route, { kind: "list" });
  return done;
});

test("a search left on a pipeline page does not follow you back to the list", () => {
  // The box doubles as jump-to-pipeline. That search did its job when it found
  // the pipeline you are looking at, and carrying it over would narrow the view
  // you just picked down to the one thing you were leaving.
  state.search = "web-app-deploy";
  state.group = "core";
  state.route = { kind: "pipeline", name: "web-app-deploy" };

  const done = selectView("Mine");

  assert.equal(state.search, "");
  assert.deepEqual(state.route, { kind: "list" });
  return done;
});

test("adopting a default view at boot keeps a deep-linked pipeline open", () => {
  // The popup and notifications open the dashboard straight on a pipeline, and
  // the default view is adopted after that route is set.
  state.route = { kind: "pipeline", name: "web-app-deploy" };
  state.search = "web";

  const done = selectView("local:starred", { resetContext: false });

  assert.deepEqual(state.route, { kind: "pipeline", name: "web-app-deploy" });
  assert.equal(state.search, "web");
  return done;
});

// ------------------------------------------- what survives a failed dashboard

test("a built-in view still knows its members when the payload never arrived", () => {
  // The names live on this machine; only their statuses came from the server.
  state.pipelines = [];
  state.groups = [];
  state.favorites = ["web-app-deploy", "api-build-test"];
  state.activeView = "local:starred";
  state.loadError = "GoCD is unreachable.";

  assert.deepEqual(rememberedNames(), ["api-build-test", "web-app-deploy"]);
});

test("watched names answer for the watched view", () => {
  state.pipelines = [];
  state.favorites = ["web-app-deploy"];
  state.watched = ["payments-nightly"];
  state.activeView = "local:watched";
  state.loadError = "GoCD is unreachable.";

  assert.deepEqual(
    rememberedNames(),
    ["payments-nightly"],
    "each view answers with its own list",
  );
});

test("a server-side view has nothing to fall back on", () => {
  // Its definition lives on GoCD, which is the thing that just did not answer.
  state.pipelines = [];
  state.favorites = ["web-app-deploy"];
  state.activeView = "Release";
  state.loadError = "GoCD is unreachable.";

  assert.deepEqual(rememberedNames(), []);
});

test("an empty view is not an outage", () => {
  // Nothing starred yet has its own thing to say, and it is not this.
  state.pipelines = [];
  state.favorites = ["web-app-deploy"];
  state.activeView = "local:starred";

  assert.deepEqual(
    rememberedNames(),
    [],
    "no error means the list is empty for an honest reason",
  );

  state.loadError = "not-configured";
  assert.deepEqual(
    rememberedNames(),
    [],
    "an unconfigured extension is not a failed request",
  );
});

test("pipelines that did load are always worth more than remembered names", () => {
  state.favorites = ["web-app-deploy"];
  state.activeView = "local:starred";
  state.loadError = "Showing the last data that loaded.";

  assert.deepEqual(
    rememberedNames(),
    [],
    "a stale cache has real pipelines to show instead",
  );
});

test("the search box still narrows the names during an outage", () => {
  state.pipelines = [];
  state.favorites = ["web-app-deploy", "api-build-test", "payments-nightly"];
  state.activeView = "local:starred";
  state.loadError = "GoCD is unreachable.";

  state.search = "api";
  assert.deepEqual(rememberedNames(), ["api-build-test"]);

  state.search = "wad";
  assert.deepEqual(
    rememberedNames(),
    ["web-app-deploy"],
    "the same fuzzy match as the list",
  );

  state.search = "zzz";
  assert.deepEqual(rememberedNames(), []);
});
