/**
 * The pipeline list, laid out the way GoCD organises it: one section per
 * pipeline group, in the server's own order, each foldable.
 *
 * What is on screen is decided by `matchingPipelines()` in state.js rather than
 * here, so that "save this as a GoCD view" saves exactly what you are looking
 * at. This file only arranges it.
 */

import { el, icon, highlighted } from "../common/ui.js";
import { pipelineStatus, runScheduledAt } from "../lib/status.js";
import {
  state,
  navigate,
  statusPill,
  stageStrip,
  relativeTime,
  tone,
  isFavorite,
  isWatched,
  toggleStar,
  toggleWatch,
  triggerPipeline,
  togglePause,
  matchingPipelines,
  rememberedNames,
  groupedMatches,
  isGroupCollapsed,
  toggleGroupCollapsed,
  setAllGroupsCollapsed,
  selectView,
} from "./state.js";

export function renderList(host) {
  const matches = matchingPipelines();
  const query = state.search.trim();

  if (!query && state.filter === "all" && !state.group) {
    const recents = recentStrip();
    if (recents) host.append(recents);
  }

  if (matches.length === 0) {
    // Nothing loaded, but a built-in view still knows its own members. Their
    // names are a way in rather than a dead end -- see `rememberedNames`.
    const remembered = rememberedNames();
    host.append(remembered.length ? knownNames(remembered) : emptyState(query));
    return;
  }

  const starred = matches.filter((m) => isFavorite(m.pipeline.name));
  if (starred.length && state.filter !== "favorites") {
    host.append(
      sectionHeader({ name: "Starred", matches: starred, pinned: true }),
    );
    host.append(grid(starred));
  }

  const sections = groupedMatches(matches);

  // A single group is not a structure worth folding: there is nothing for it to
  // be folded away from.
  if (sections.length === 1) {
    if (!state.group)
      host.append(sectionHeader({ ...sections[0], alwaysOpen: true }));
    host.append(grid(sections[0].matches));
    return;
  }

  if (sections.length > 1) host.append(collapseAllBar(sections));

  for (const section of sections) {
    host.append(sectionHeader(section));
    if (!isGroupCollapsed(section.name)) host.append(grid(section.matches));
  }
}

function collapseAllBar(sections) {
  const allCollapsed = sections.every((section) =>
    isGroupCollapsed(section.name),
  );
  return el(
    "div",
    { class: "list-toolbar" },
    el("span", {
      class: "faint",
      text: `${sections.length} groups`,
    }),
    el("span", { class: "spacer" }),
    el(
      "button",
      {
        class: "btn btn-sm btn-ghost",
        onclick: () => setAllGroupsCollapsed(!allCollapsed),
      },
      icon(allCollapsed ? "chevron-down" : "chevron-right", { size: 12 }),
      allCollapsed ? "Expand all" : "Collapse all",
    ),
  );
}

function sectionHeader({ name, matches, pinned = false, alwaysOpen = false }) {
  const failing = matches.filter(
    (m) => pipelineStatus(m.pipeline) === "Failed",
  ).length;
  const building = matches.filter(
    (m) => pipelineStatus(m.pipeline) === "Building",
  ).length;
  const fixed = pinned || alwaysOpen;
  const collapsed = !fixed && isGroupCollapsed(name);

  const contents = [
    pinned
      ? icon("star-filled", { size: 13, class: "section-star" })
      : icon(collapsed ? "chevron-right" : "chevron-down", { size: 14 }),
    el("span", { class: "section-name", text: name }),
    el("span", { class: "section-count", text: String(matches.length) }),
    failing > 0 &&
      el("span", {
        class: "section-tag tone-fail",
        text: `${failing} failing`,
      }),
    building > 0 &&
      el("span", {
        class: "section-tag tone-build",
        text: `${building} running`,
      }),
  ];

  if (fixed) return el("div", { class: "section-head pinned" }, ...contents);

  return el(
    "button",
    {
      class: "section-head",
      "aria-expanded": String(!collapsed),
      onclick: () => toggleGroupCollapsed(name),
    },
    ...contents,
  );
}

/**
 * Every pipeline in the section, not a page of them. Groups start collapsed and
 * opening one is a deliberate ask for what is in it, so a cap and a "show the
 * rest" button only put a second click in front of the answer.
 */
function grid(entries) {
  const node = el("div", { class: "grid" });
  for (const entry of entries) node.append(card(entry));
  return node;
}

function card({ pipeline, hits, viaGroup }) {
  const status = pipelineStatus(pipeline);
  const run = pipeline._embedded?.instances?.[0];
  const stages = run?._embedded?.stages || [];
  const paused = Boolean(pipeline.pause_info?.paused);
  const starred = isFavorite(pipeline.name);
  const watching = isWatched(pipeline.name);

  const name = el("span", { class: "name truncate" });
  name.append(highlighted(pipeline.name, hits));

  const actions = el(
    "span",
    { class: "card-actions" },
    iconAction(
      watching ? "bell-filled" : "bell",
      watching
        ? "Stop notifying me about this"
        : "Notify me when this starts and finishes",
      () => toggleWatch(pipeline.name),
      watching,
      "watching",
    ),
    iconAction(
      starred ? "star-filled" : "star",
      starred ? "Unstar" : "Star this pipeline",
      () => toggleStar(pipeline.name),
      starred,
    ),
    iconAction("play", "Run now", () => triggerPipeline(pipeline.name)),
    iconAction(paused ? "play" : "pause", paused ? "Resume" : "Pause", () =>
      togglePause(pipeline),
    ),
  );

  const body = el(
    "div",
    { class: "card-body" },
    el("div", { class: "row" }, name, actions),
    el(
      "div",
      { class: "card-meta" },
      statusPill(status),
      watching &&
        el(
          "span",
          {
            class: "watch-flag",
            title: "You are being notified about this one",
          },
          icon("bell-filled", { size: 11 }),
        ),
      paused &&
        el(
          "span",
          { class: "paused-flag" },
          icon("pause", { size: 12 }),
          "Paused",
        ),
      // Only worth the space when the row is here because its *group* matched.
      viaGroup &&
        el(
          "span",
          { class: "via-group" },
          icon("folder", { size: 11 }),
          viaGroup,
        ),
      run?.label &&
        el("span", {
          class: "truncate mono",
          text: run.label,
          title: run.label,
        }),
      el("span", { class: "spacer" }),
      relativeTime(runScheduledAt(run)),
    ),
  );

  const open = () => navigate({ kind: "pipeline", name: pipeline.name });

  return el(
    "div",
    {
      class: `card-p edge-${tone(status)}`,
      role: "button",
      tabindex: 0,
      onclick: (event) => {
        if (event.target.closest(".card-actions")) return;
        open();
      },
      onkeydown: (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      },
    },
    body,
    stageStrip(stages),
  );
}

function iconAction(
  name,
  title,
  onClick,
  active = false,
  activeClass = "starred",
) {
  return el(
    "button",
    {
      class: `icon-btn${active ? ` ${activeClass}` : ""}`,
      title,
      "aria-label": title,
      onclick: (event) => {
        event.stopPropagation();
        onClick();
      },
    },
    icon(name),
  );
}

/**
 * A row of chips for pipelines opened recently -- the usual reason you came
 * back. Five: enough to be a shortcut, few enough not to become a second list
 * competing with the one below it.
 */
const RECENT_SHOWN = 5;

function recentStrip() {
  const known = new Set(state.pipelines.map((p) => p.name));
  const recents = (state.recent || [])
    .filter((name) => known.has(name))
    .slice(0, RECENT_SHOWN);
  if (recents.length < 2) return null;

  const strip = el(
    "div",
    { class: "recent-strip" },
    el("span", { class: "recent-label", text: "Recent" }),
  );
  for (const name of recents) {
    const pipeline = state.pipelines.find((p) => p.name === name);
    strip.append(
      el(
        "button",
        {
          class: "recent-chip",
          title: name,
          onclick: () => navigate({ kind: "pipeline", name }),
        },
        el("span", {
          class: `recent-dot tone-${tone(pipelineStatus(pipeline))}`,
        }),
        el("span", { class: "truncate", text: name }),
      ),
    );
  }
  return strip;
}

/**
 * Pipelines we can name but cannot describe: no status, because the payload
 * that carries it never arrived. Deliberately not cards and deliberately not a
 * status pill -- "Never run" would be an answer, and this is the absence of one.
 */
function knownNames(names) {
  const watching = state.activeView === "local:watched";
  const panel = el(
    "div",
    { class: "panel" },
    el(
      "div",
      { class: "panel-head" },
      icon(watching ? "bell" : "star", { size: 13 }),
      watching ? "Pipelines you are watching" : "Pipelines you starred",
      el("span", { class: "spacer" }),
      el("span", { text: String(names.length) }),
    ),
    el("div", {
      class: "name-note",
      text: "The dashboard did not load, so there is no status to show. Opening one of these still works.",
    }),
  );

  for (const name of names) {
    panel.append(
      el(
        "button",
        {
          class: "name-row",
          onclick: () => navigate({ kind: "pipeline", name }),
        },
        icon("layers", { size: 13 }),
        el("span", { class: "truncate", text: name }),
        icon("chevron-right", { size: 13 }),
      ),
    );
  }

  return panel;
}

function emptyState(query) {
  // The extension's own views are empty until the user fills them, which is not
  // the same problem as a GoCD view that matches nothing.
  if (state.pipelines.length === 0 && state.activeView === "local:starred") {
    return el(
      "div",
      { class: "empty" },
      icon("star", { size: 30 }),
      el("h3", { text: "Nothing starred yet" }),
      el("p", {
        text: "Press the star on any pipeline and it collects here, across every group. Pick a GoCD view above to go and find some.",
      }),
    );
  }

  if (state.pipelines.length === 0 && state.activeView === "local:watched") {
    return el(
      "div",
      { class: "empty" },
      icon("bell", { size: 30 }),
      el("h3", { text: "Not watching anything yet" }),
      el("p", {
        text: "Press the bell on a pipeline to be told when it starts and when it finishes. Watched pipelines collect here.",
      }),
    );
  }

  if (state.pipelines.length === 0 && state.activeView) {
    return el(
      "div",
      { class: "empty" },
      icon("list", { size: 30 }),
      el("h3", { text: `The "${state.activeView}" view is empty` }),
      el("p", {
        text: "That GoCD view does not match any pipeline you can see right now. It may have been built around pipelines that were since renamed or removed.",
      }),
      el("button", {
        class: "btn",
        text: "Show every pipeline instead",
        onclick: () => selectView(null),
      }),
    );
  }

  if (state.pipelines.length === 0) {
    return el(
      "div",
      { class: "empty" },
      icon("layers", { size: 30 }),
      el("h3", { text: "No pipelines yet" }),
      el("p", {
        text: "Either this GoCD server has none you can see, or the first load has not finished. Press refresh to try again.",
      }),
    );
  }

  return el(
    "div",
    { class: "empty" },
    icon("search", { size: 30 }),
    el("h3", { text: "Nothing matches" }),
    el("p", {
      text: query
        ? `No pipeline or group matches "${query}" with the filters you have on.`
        : "No pipeline matches the filters you have on.",
    }),
  );
}
