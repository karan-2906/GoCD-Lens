/**
 * The dashboard's single source of truth, plus the pieces of UI that more than
 * one view needs. Views read `state`, mutate it, and call `rerender()`; nothing
 * here reaches into the DOM of a specific view.
 */

import {
  el,
  send,
  toast,
  confirmDialog,
  explain,
  stageStrip,
} from "../common/ui.js";
import {
  STATUS,
  pipelineStatus,
  timeAgo,
  matchScore,
  fuzzyMatch,
} from "../lib/status.js";

export const state = {
  /** {kind: 'list'} or {kind: 'pipeline', name} */
  route: { kind: "list" },
  connection: null,
  hasPermission: false,
  settings: null,
  favorites: [],
  /** Pipelines the user asked to be notified about, start and finish. */
  watched: [],
  groups: [],
  pipelines: [],
  /** The user's GoCD personalized views, as the web dashboard's tabs show them. */
  views: [],
  activeView: null,
  viewsAvailable: true,
  recent: [],
  /**
   * Group names the user has opened, remembered between visits. Stored this way
   * round because groups start shut -- a dozen open groups is a wall of cards.
   */
  expandedGroups: [],
  fetchedAt: 0,
  stale: false,
  loadError: null,
  search: "",
  /** The sidebar's own box. It narrows the group list and nothing else. */
  groupSearch: "",
  /** 'all' | 'failing' | 'building' | 'paused' | 'favorites' */
  filter: "all",
  group: null,
};

let renderFn = () => {};

export function onRender(fn) {
  renderFn = fn;
}

export function rerender() {
  renderFn();
}

/**
 * Pipelines you passed through to reach the one on screen, oldest first.
 *
 * Only pipeline-to-pipeline hops go in here: the list is the root of the app,
 * so arriving there empties it. A pipeline page can open another pipeline --
 * the run that triggered this one -- and back has to mean "the one I came
 * from", not "the list", or following a chain upstream is a one-way trip.
 *
 * Capped because the chain can be walked in circles: A triggered by B, open B,
 * open the run of A that triggered it, and so on. Dropping the oldest entry
 * means back always terminates at the list.
 */
const trail = [];
const TRAIL_MAX = 10;

export function navigate(route) {
  if (route.kind === "list") trail.length = 0;
  else if (state.route.kind === "pipeline" && state.route.name !== route.name) {
    trail.push(state.route.name);
    if (trail.length > TRAIL_MAX) trail.shift();
  }
  setRoute(route);
}

/** Up one level: the pipeline that opened this one, else the list. */
export function goBack() {
  const previous = trail.pop();
  setRoute(previous ? { kind: "pipeline", name: previous } : { kind: "list" });
}

/** What `goBack()` would land on, so the button can say where it goes. */
export function backTarget() {
  return trail.length ? trail[trail.length - 1] : null;
}

/**
 * Drop to the list without redrawing, for callers that are about to render
 * anyway. They cannot just assign `state.route`: a trail left behind would
 * send the next back press to a pipeline the user has already left.
 */
export function resetToList() {
  state.route = { kind: "list" };
  trail.length = 0;
}

function setRoute(route) {
  state.route = route;
  rerender();
  document.querySelector(".content")?.scrollTo({ top: 0 });
}

export function pipelineByName(name) {
  return state.pipelines.find((p) => p.name === name) || null;
}

export function groupOf(name) {
  return (
    state.groups.find((g) => (g.pipelines || []).includes(name))?.name || null
  );
}

export function isFavorite(name) {
  return state.favorites.includes(name);
}

export function isWatched(name) {
  return state.watched.includes(name);
}

// ---------------------------------------------------------------- refresh

let refreshing = false;

/**
 * A cheap stand-in for "is this the same dashboard as last time".
 *
 * The ETag answers it for free when the server sends one. Without it -- a proxy
 * that strips headers, or a built-in view we filtered ourselves -- fall back to
 * hashing what is actually on screen, which is a few hundred thousand character
 * comparisons rather than rebuilding a few thousand DOM nodes.
 */
function fingerprint(data) {
  if (data.etag) return `${data.view ?? ""}|${data.etag}`;

  let hash = 0;
  for (const pipeline of data.pipelines || []) {
    const row = `${pipeline.name}:${pipelineStatus(pipeline)}:${pipeline.pause_info?.paused ? 1 : 0}`;
    for (let i = 0; i < row.length; i += 1)
      hash = (hash * 31 + row.charCodeAt(i)) | 0;
  }
  return `${data.view ?? ""}|${data.pipelines?.length ?? 0}|${hash}`;
}

let lastFingerprint = null;

/**
 * @param {object} [options]
 * @param {string|null} [options.view] Omit to keep the current view; pass null
 *   for every pipeline, or a name to switch to that GoCD view.
 */
export async function refresh({ force = false, quiet = false, view } = {}) {
  if (refreshing) return;
  refreshing = true;
  let changed = true;
  try {
    // Leaving `view` out of the payload is what tells the worker to keep the
    // selection; sending null would mean "show me everything".
    const payload = { force };
    if (view !== undefined) payload.view = view;
    const data = await send("refresh", payload);
    if (data.configured === false) {
      state.loadError = "not-configured";
      return;
    }
    state.groups = data.groups || [];
    state.pipelines = data.pipelines || [];
    state.fetchedAt = data.fetchedAt || Date.now();
    state.stale = Boolean(data.stale);
    state.loadError = data.error || null;
    state.activeView = data.view ?? null;

    // Most polls come back identical -- that is the point of the ETag. Redrawing
    // thousands of cards to arrive at the same picture costs a visible stutter,
    // resets the scroll position, and drops whatever the pointer was over.
    const next = fingerprint(data);
    changed = next !== lastFingerprint || Boolean(data.stale);
    lastFingerprint = next;
  } catch (err) {
    state.stale = true;
    state.loadError = explain(err);
    lastFingerprint = null; // an error changes what is on screen
    if (!quiet) toast(state.loadError, { tone: "error", timeout: 7000 });
  } finally {
    refreshing = false;
    if (changed) rerender();
    else repaintFreshness();
  }
}

/** Set by the shell, so an unchanged poll can update the clock and nothing else. */
let freshnessFn = () => {};

export function onFreshness(fn) {
  freshnessFn = fn;
}

function repaintFreshness() {
  freshnessFn();
}

// ------------------------------------------------------------ shared bits

export function statusPill(status, { small = false } = {}) {
  const meta = STATUS[status] || STATUS.Unknown;
  return el("span", {
    class: `pill tone-${meta.tone}${small ? " pill-sm" : ""}`,
    text: meta.label,
  });
}

export function tone(status) {
  return (STATUS[status] || STATUS.Unknown).tone;
}

export { stageStrip };

export function relativeTime(epochMillis) {
  return el("span", {
    class: "faint",
    text: timeAgo(epochMillis),
    title: epochMillis ? new Date(epochMillis).toLocaleString() : "",
  });
}

// --------------------------------------------------------------- actions

export async function toggleStar(name) {
  state.favorites = await send("toggleFavorite", { name });
  rerender();
}

export async function toggleWatch(name) {
  const watching = !isWatched(name);
  state.watched = await send("toggleWatched", { name });
  rerender();

  if (!watching) {
    toast(`No longer watching ${name}.`, { tone: "info", timeout: 3000 });
    return;
  }

  // Background checking is off by default to keep load off the server, which
  // means a watched pipeline cannot reach you with nothing open. Better to say
  // so now than to leave someone waiting for an alert that will never come.
  if (!state.settings?.notifyWhenClosed) {
    toast(
      `Watching ${name}, but you will only be told while a tab is open. Settings has a tick for "Notify me even when no dashboard tab is open".`,
      { tone: "warn", timeout: 9000 },
    );
    return;
  }

  toast(
    `Watching ${name} -- you will be told when a run starts and when it finishes.`,
    {
      tone: "ok",
      timeout: 3500,
    },
  );
}

/** Every action that changes something on the server asks first, then says what happened. */
async function act(label, run) {
  try {
    await run();
    toast(label, { tone: "ok" });
    setTimeout(() => refresh({ force: true, quiet: true }), 1200);
    return true;
  } catch (err) {
    toast(explain(err), { tone: "error", timeout: 8000 });
    return false;
  }
}

export async function triggerPipeline(name) {
  const ok = await confirmDialog({
    title: `Run ${name}?`,
    body: "GoCD will schedule a new run using the latest materials.",
    confirmLabel: "Run it",
  });
  if (!ok) return;
  return act(`Triggered ${name}`, () => send("trigger", { pipeline: name }));
}

export async function togglePause(pipeline) {
  const paused = pipeline.pause_info?.paused;
  if (paused) {
    const ok = await confirmDialog({
      title: `Resume ${pipeline.name}?`,
      body: pipeline.pause_info?.pause_reason
        ? `It was paused because: ${pipeline.pause_info.pause_reason}`
        : "Scheduling will start again straight away.",
      confirmLabel: "Resume",
    });
    if (!ok) return;
    return act(`Resumed ${pipeline.name}`, () =>
      send("unpause", { pipeline: pipeline.name }),
    );
  }

  const reason = el("input", {
    type: "text",
    placeholder: "Why? (everyone on this server will see it)",
    spellcheck: false,
  });
  const ok = await confirmDialog({
    title: `Pause ${pipeline.name}?`,
    body: el(
      "div",
      {},
      el("p", {
        class: "modal-body",
        text: "New runs stop being scheduled. Anything already running keeps going.",
      }),
      reason,
    ),
    confirmLabel: "Pause",
  });
  if (!ok) return;
  return act(`Paused ${pipeline.name}`, () =>
    send("pause", { pipeline: pipeline.name, cause: reason.value.trim() }),
  );
}

export async function cancelStage({ pipeline, counter, stage, stageCounter }) {
  const ok = await confirmDialog({
    title: `Stop ${stage}?`,
    body: `This cancels the running stage in ${pipeline} #${counter}. Work already done is kept, but the run stops here.`,
    confirmLabel: "Stop it",
    tone: "danger",
  });
  if (!ok) return;
  return act(`Cancelled ${stage}`, () =>
    send("cancelStage", { pipeline, counter, stage, stageCounter }),
  );
}

/**
 * Re-run a stage, choosing which jobs.
 *
 * A stage with a dozen parallel jobs is normal, and when one flaky job fails,
 * re-running the whole stage burns agent time on eleven that already passed.
 * The failed jobs start ticked, because that is nearly always the answer.
 */
/**
 * The choice is made inline, on the job rows, so this only confirms it.
 *
 * `selected` is null when there was nothing to choose between -- one job, or a
 * stage whose rows carry no checkboxes -- and an array of job names otherwise.
 * Empty or complete both mean the whole stage: running every job is what
 * "re-run the stage" means, and GoCD has its own operation for it rather than
 * treating it as a selection that happens to include everything.
 */
export async function rerunStage({
  pipeline,
  counter,
  stage,
  stageCounter,
  jobs = [],
  selected = null,
}) {
  const runnable = jobs.filter((job) => job?.name);
  const picked = selected ?? [];
  const whole = picked.length === 0 || picked.length === runnable.length;

  const named =
    picked.length <= 3
      ? picked.join(", ")
      : `${picked.length} of ${runnable.length} jobs`;

  const ok = await confirmDialog({
    title: whole
      ? `Re-run ${stage}?`
      : `Re-run ${picked.length === 1 ? "this job" : "these jobs"}?`,
    body: whole
      ? "Every job in this stage runs again."
      : `${named} run again. The rest keep their existing result.`,
    confirmLabel: whole ? "Re-run" : "Re-run selected",
  });
  if (!ok) return;

  const label = whole
    ? `Re-running ${stage}`
    : `Re-running ${picked.length} job${picked.length === 1 ? "" : "s"} in ${stage}`;

  return act(label, () =>
    send("rerun", {
      pipeline,
      counter,
      stage,
      stageCounter,
      jobs: whole ? undefined : picked,
    }),
  );
}

export async function openInGoCd(kind, parts) {
  try {
    const { url } = await send("webUrl", { kind, parts });
    chrome.tabs.create({ url });
  } catch (err) {
    toast(explain(err), { tone: "error" });
  }
}

// ---------------------------------------------------------------- filtering

export function counts() {
  const all = state.pipelines;
  return {
    all: all.length,
    failing: all.filter((p) => pipelineStatus(p) === "Failed").length,
    building: all.filter((p) => pipelineStatus(p) === "Building").length,
    paused: all.filter((p) => p.pause_info?.paused).length,
    favorites: all.filter((p) => isFavorite(p.name)).length,
    watched: all.filter((p) => isWatched(p.name)).length,
  };
}

/**
 * A group-name hit is worth showing but should never outrank a pipeline-name
 * hit, so it is pushed past every possible name score.
 */
const GROUP_MATCH_PENALTY = 100_000;

/**
 * The one place that decides which pipelines are on screen, given the search
 * box, the filter chips and the selected group. The list view renders this and
 * "save as a GoCD view" saves it, so the two can never disagree about what
 * "what I am looking at" means.
 *
 * Searching matches a pipeline's own name first, and falls back to its group's
 * name -- so typing `core` finds everything in the core group without having to
 * click over to it.
 */
export function matchingPipelines() {
  const query = state.search.trim();
  const groupByPipeline = new Map();
  for (const group of state.groups) {
    for (const name of group.pipelines || [])
      groupByPipeline.set(name, group.name);
  }

  const inGroup = state.group
    ? new Set(state.groups.find((g) => g.name === state.group)?.pipelines || [])
    : null;

  const matches = [];
  for (const pipeline of state.pipelines) {
    if (inGroup && !inGroup.has(pipeline.name)) continue;
    if (!passesFilter(pipeline)) continue;

    const group = groupByPipeline.get(pipeline.name) || null;
    let score = 0;
    let hits = [];
    let viaGroup = null;

    if (query) {
      const nameScore = matchScore(query, pipeline.name);
      if (nameScore !== null) {
        score = nameScore;
        hits = fuzzyMatch(query, pipeline.name) || [];
      } else {
        const groupScore = group ? matchScore(query, group) : null;
        if (groupScore === null) continue;
        score = groupScore + GROUP_MATCH_PENALTY;
        viaGroup = group;
      }
    }

    matches.push({ pipeline, score, hits, viaGroup, group });
  }

  matches.sort((a, b) => {
    if (query)
      return (
        a.score - b.score || a.pipeline.name.localeCompare(b.pipeline.name)
      );
    const rankA = STATUS[pipelineStatus(a.pipeline)].rank;
    const rankB = STATUS[pipelineStatus(b.pipeline)].rank;
    return rankA - rankB || a.pipeline.name.localeCompare(b.pipeline.name);
  });

  return matches;
}

/**
 * Matches split into their GoCD pipeline groups, in the order the server lists
 * them. That order is the one configured on the server and the one the web UI
 * shows, so it is the order people already know -- sorting alphabetically here
 * would quietly rearrange someone's mental map of their own instance.
 */
export function groupedMatches(matches) {
  const sections = new Map();
  for (const match of matches) {
    const key = match.group || "Ungrouped";
    if (!sections.has(key)) sections.set(key, []);
    sections.get(key).push(match);
  }

  const ordered = [];
  for (const group of state.groups) {
    if (sections.has(group.name)) {
      ordered.push({ name: group.name, matches: sections.get(group.name) });
      sections.delete(group.name);
    }
  }
  // Anything whose group the dashboard did not describe still has to appear.
  for (const [name, groupMatches] of sections)
    ordered.push({ name, matches: groupMatches });
  return ordered;
}

/**
 * The rows the sidebar lists: every group with at least one pipeline in the
 * current view, narrowed by the sidebar's own filter box.
 *
 * A group whose pipelines are all outside the view is dropped rather than shown
 * empty -- on this instance that would be most of several hundred rows. The
 * filter uses the same subsequence match as the pipeline search, so `agp` finds
 * `agent-os-customer-intelligence-prod`, and ranks hits the same way; with no
 * query every score is 0 and the list falls back to alphabetical.
 */
export function visibleGroups() {
  const byName = new Map(state.pipelines.map((p) => [p.name, p]));
  const query = state.groupSearch.trim();

  const rows = [];
  for (const group of state.groups) {
    const members = (group.pipelines || [])
      .map((n) => byName.get(n))
      .filter(Boolean);
    if (members.length === 0) continue;
    const score = query ? matchScore(query, group.name) : 0;
    if (score === null) continue;
    rows.push({ name: group.name, members, score });
  }

  rows.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return rows;
}

/**
 * What a built-in view can still show when the payload it filters never came.
 *
 * `local:starred` and `local:watched` are lists of names kept on this machine,
 * so their definition outlives the request that would have coloured them in --
 * the same reasoning as `retryUnfiltered`, one step further. Names are all that
 * survives: no status, no stages, nothing that came from the server. They are
 * still worth putting on screen, because the pipeline page reads a different
 * endpoint, and the dashboard being down does not mean that one is.
 *
 * Empty unless the list is genuinely empty *because* the load failed -- a view
 * you have not filled yet has its own thing to say, and a stale cache has real
 * pipelines to show instead.
 */
export function rememberedNames() {
  if (state.pipelines.length > 0) return [];
  if (!state.loadError || state.loadError === "not-configured") return [];

  const names =
    state.activeView === "local:starred"
      ? state.favorites
      : state.activeView === "local:watched"
        ? state.watched
        : [];

  const query = state.search.trim();
  const ranked = [];
  for (const name of names) {
    const score = query ? matchScore(query, name) : 0;
    if (score === null) continue;
    ranked.push({ name, score });
  }

  ranked.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return ranked.map((row) => row.name);
}

export function isGroupCollapsed(name) {
  // A search has to reach into folded groups, or it looks broken.
  if (state.search.trim()) return false;
  return !state.expandedGroups.includes(name);
}

export async function toggleGroupCollapsed(name) {
  const next = state.expandedGroups.includes(name)
    ? state.expandedGroups.filter((n) => n !== name)
    : [...state.expandedGroups, name];
  state.expandedGroups = next;
  rerender();
  state.expandedGroups = await send("setExpandedGroups", { names: next });
}

export async function setAllGroupsCollapsed(collapsed) {
  const names = collapsed
    ? []
    : groupedMatches(matchingPipelines()).map((section) => section.name);
  state.expandedGroups = names;
  rerender();
  state.expandedGroups = await send("setExpandedGroups", { names });
}

export function passesFilter(pipeline) {
  switch (state.filter) {
    case "failing":
      return pipelineStatus(pipeline) === "Failed";
    case "building":
      return pipelineStatus(pipeline) === "Building";
    case "paused":
      return Boolean(pipeline.pause_info?.paused);
    case "favorites":
      return isFavorite(pipeline.name);
    case "watched":
      return isWatched(pipeline.name);
    default:
      return true;
  }
}

// ------------------------------------------------------- personalized views

/**
 * The same views the user built as tabs in the GoCD web dashboard. GoCD filters
 * the payload server-side, so selecting one narrows everything -- list, sidebar,
 * badge and notifications -- in a single request.
 */
export async function loadViews() {
  try {
    const { filters } = await send("views");
    state.views = filters || [];
    state.viewsAvailable = true;
  } catch {
    // Some servers lock this endpoint down. Views are a convenience, not a
    // requirement, so their absence must not break the dashboard.
    state.views = [];
    state.viewsAvailable = false;
  }
  rerender();
}

export async function selectView(name, { resetContext = true } = {}) {
  if ((state.activeView ?? null) === (name ?? null)) return;
  state.activeView = name ?? null;
  // A group chosen inside the old view is probably meaningless in this one, and
  // the list is the only place the view you just picked is visible.
  if (resetContext) {
    state.group = null;
    // A search you typed against the list is a filter you still want, so it
    // carries over and re-runs against the new view. The exception is one left
    // behind on a pipeline page: the box doubles as jump-to-pipeline, and that
    // search did its job when it found the thing you are looking at -- taking
    // it back to the list would narrow the new view down to what you just left.
    // The sidebar box only ever filters, so it is never a leftover.
    if (state.route.kind !== "list") state.search = "";
    resetToList();
  }
  rerender();
  await refresh({ force: true, view: name ?? null });
}
