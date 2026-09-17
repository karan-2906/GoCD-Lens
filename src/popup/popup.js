/**
 * The toolbar popup: a glance, not a workspace. It answers "is anything red?"
 * and gets out of the way.
 *
 * It carries the same view picker as the dashboard, because the answer to that
 * question depends entirely on which pipelines you consider yours, and a search
 * box, because on a server with thousands of pipelines scrolling is not a way
 * to find one.
 */

import {
  $,
  el,
  icon,
  clear,
  send,
  applyTheme,
  loadSprite,
  explain,
  highlighted,
  stageStrip,
  applyOverflowTitles,
} from '../common/ui.js';
import {
  pipelineStatus,
  STATUS,
  freshnessAgo,
  matchScore,
  fuzzyMatch,
} from '../lib/status.js';

let pipelines = [];
let favorites = [];
let watched = [];
let views = [];
let activeView = null;
let fetchedAt = 0;
let query = '';
/** How many rows are on screen; Load more raises it. */
let shown = 8;

init();

async function init() {
  await loadSprite();
  $('#refresh').append(icon('refresh'));
  $('#settings').append(icon('settings'));
  $('#search-icon').append(icon('search', { size: 13 }));
  $('#search-clear').append(icon('x', { size: 12 }));
  $('#view-picker-icon').append(icon('list', { size: 13 }));

  $('#refresh').title = 'Fetch the latest from GoCD now';
  $('#settings').title = 'Settings - connection, alerts, sounds and refresh rate';

  $('#settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('#open-dashboard').addEventListener('click', () => openDashboard());
  $('#refresh').addEventListener('click', () => load({ force: true }));
  $('#view-select').addEventListener('change', (event) =>
    load({ force: true, view: event.target.value }),
  );
  wireSearch();

  const bootstrap = await send('getState');
  applyTheme(bootstrap.settings.theme);
  favorites = bootstrap.favorites;
  watched = bootstrap.watched || [];
  views = bootstrap.views || [];
  activeView = bootstrap.settings.activeView ?? null;

  if (!bootstrap.connection) {
    renderNotConnected();
    return;
  }

  restoreSearch(bootstrap.popupSearch || '');

  if (bootstrap.cache) {
    pipelines = bootstrap.cache.pipelines || [];
    fetchedAt = bootstrap.cache.fetchedAt || 0;
    activeView = bootstrap.cache.view ?? activeView;
    render();
  } else {
    paintViewPicker();
    renderLoading();
  }

  load();
}

function wireSearch() {
  const search = $('#search');
  search.addEventListener('input', () => {
    query = search.value;
    $('#search-clear').hidden = !query;
    shown = 8;
    rememberSearch();
    render();
  });

  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && query) {
      event.stopPropagation();
      clearSearch();
      return;
    }
    // Enter opens the best match in the full dashboard, where there is room to
    // actually do something with it.
    if (event.key !== 'Enter') return;
    const best = matches()[0];
    if (best) openDashboard({ pipeline: best.pipeline.name });
  });

  $('#search-clear').addEventListener('click', clearSearch);
}

function clearSearch() {
  query = '';
  $('#search').value = '';
  $('#search-clear').hidden = true;
  shown = 8;
  rememberSearch();
  render();
  $('#search').focus();
}

/**
 * Written on every keystroke rather than debounced, because the popup is torn
 * down the instant it loses focus and a pending timer goes with it. That is
 * affordable only in `storage.local`; `storage.sync`, which has a write-rate
 * quota, is banned here for other reasons anyway.
 */
function rememberSearch() {
  // Failing to remember a search is not worth interrupting anyone over.
  send('setPopupSearch', { query }).catch(() => {});
}

/** Picks up a search from a popup dismissed moments ago; see the store's TTL. */
function restoreSearch(saved) {
  if (!saved) return;
  query = saved;
  const search = $('#search');
  search.value = saved;
  $('#search-clear').hidden = false;
  // Handing back text with no caret in it is half the feature: the reason you
  // are back is usually to type one more character, or to clear it.
  search.focus();
  search.setSelectionRange(saved.length, saved.length);
}

async function load({ force = false, view } = {}) {
  const spinner = $('#refresh').querySelector('.icon');
  spinner?.classList.add('spin');
  try {
    // Omitting `view` keeps whatever is selected; passing one switches to it.
    const payload = { force };
    if (view !== undefined) {
      payload.view = view;
      shown = 8; // a different view is a different list
    }
    const data = await send('refresh', payload);
    pipelines = data.pipelines || [];
    fetchedAt = data.fetchedAt || Date.now();
    activeView = data.view ?? null;
    render(data.stale ? data.error : null);
  } catch (err) {
    render(explain(err));
  } finally {
    spinner?.classList.remove('spin');
  }
}

function paintViewPicker() {
  // Counts follow the search box. A picker reading "Starred (4)" above a list
  // showing one is describing a set that is no longer on screen.
  const needle = query.trim();
  const matching = (names) =>
    needle ? names.filter((name) => matchScore(needle, name) !== null).length : names.length;

  // An option still has to exist when nothing in it matches, or a search that
  // empties the view you are in also removes the way back out of it.
  const builtins = [];
  if (favorites.length)
    builtins.push({ value: 'local:starred', label: 'Starred', count: matching(favorites) });
  if (watched.length)
    builtins.push({ value: 'local:watched', label: 'Watching', count: matching(watched) });

  const picker = $('#view-picker');
  picker.hidden = views.length === 0 && builtins.length === 0;
  if (picker.hidden) return;

  const select = clear($('#view-select'));
  for (const builtin of builtins) {
    select.append(
      el('option', {
        value: builtin.value,
        text: `${builtin.label}  (${builtin.count})`,
        selected: activeView === builtin.value,
      }),
    );
  }
  for (const view of views) {
    select.append(
      el('option', { value: view.name, text: view.name, selected: activeView === view.name }),
    );
  }
  // A view deleted on the server would otherwise leave this showing the first
  // entry while the data on screen came from another.
  const known = [...builtins.map((b) => b.value), ...views.map((v) => v.name)];
  if (activeView && !known.includes(activeView)) {
    select.append(el('option', { value: activeView, text: activeView, selected: true }));
  }
}

/** Fuzzy matches within the current view, best first. */
function matches() {
  const needle = query.trim();
  if (!needle) return [];
  return pipelines
    .map((pipeline) => ({ pipeline, score: matchScore(needle, pipeline.name) }))
    .filter((match) => match.score !== null)
    .sort((a, b) => a.score - b.score || a.pipeline.name.localeCompare(b.pipeline.name))
    .map((match) => ({ ...match, hits: fuzzyMatch(needle, match.pipeline.name) || [] }));
}

/**
 * One list, worst first, capped and paged.
 *
 * It used to show only the exceptional bands and then stop, so a view with
 * nothing failing showed "All green" and nothing you could click, and the
 * "and 3 more" line was a label rather than a button. Now everything in the
 * view is reachable: failures lead, then whatever is running, then the rest --
 * and Load more walks through it without leaving the popup.
 */
const PAGE = 8;

function banded() {
  const sections = [];

  const running = pipelines.filter((p) => pipelineStatus(p) === 'Building');
  if (running.length) {
    sections.push({ title: `Running now (${running.length})`, members: running });
  }

  // Everything else in the view, with the pipelines you picked out at the top
  // so the tail is not just alphabetical noise.
  const placed = new Set(running.map((p) => p.name));
  const rest = pipelines.filter((p) => !placed.has(p.name));
  rest.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  if (rest.length) {
    // "Other" only means anything when something came before it.
    sections.push({
      title: sections.length ? 'Other pipelines in view' : 'Pipelines in view',
      members: rest,
    });
  }

  return sections;
}

function rank(pipeline) {
  if (watched.includes(pipeline.name)) return 0;
  if (favorites.includes(pipeline.name)) return 1;
  if (pipeline.pause_info?.paused) return 3;
  return 2;
}

function viewLabel() {
  if (activeView === 'local:starred') return 'Starred';
  if (activeView === 'local:watched') return 'Watching';
  return activeView || 'All pipelines';
}

function render(warning = null) {
  // One set of pipelines feeds the whole popup. Hiding 37 of 40 rows behind a
  // search does not leave four of them running, and the tiles are the first
  // thing read -- so they count what is on screen, not what is behind it.
  const found = query.trim() ? matches() : null;
  const inView = found ? found.map((match) => match.pipeline) : pipelines;
  const failing = inView.filter((p) => pipelineStatus(p) === 'Failed');
  const running = inView.filter((p) => pipelineStatus(p) === 'Building');

  paintViewPicker();

  $('#freshness').textContent = fetchedAt ? freshnessAgo(fetchedAt) : '';

  const summary = clear($('#summary'));
  summary.append(
    stat('fail', failing.length, 'Failing', 'failing'),
    stat('build', running.length, 'Running', 'building'),
    stat('pass', inView.length - failing.length - running.length, 'Green', 'all'),
  );

  const body = clear($('#body'));

  if (warning) {
    body.append(
      el(
        'div',
        { class: 'banner banner-warn', style: { marginBottom: '8px' } },
        icon('offline'),
        el('span', { text: warning }),
      ),
    );
  }

  if (found) {
    paintSections(body, [{ title: null, members: found }], { searching: true });
    titleClippedRows();
    return;
  }

  if (pipelines.length === 0) {
    body.append(
      el(
        'div',
        { class: 'empty' },
        icon('layers', { size: 24 }),
        el('h3', { text: 'Nothing in this view' }),
        el('p', { text: 'Pick another view above, or open the dashboard to go and find some.' }),
      ),
    );
    return;
  }

  paintSections(body, banded(), {});
  titleClippedRows();
}

/**
 * Render sections against one shared budget, so Load more extends the whole
 * list rather than just the band it happens to sit under.
 */
function paintSections(body, sections, { searching = false }) {
  const total = sections.reduce((sum, section) => sum + section.members.length, 0);

  if (searching && total === 0) {
    body.append(
      el(
        'div',
        { class: 'empty' },
        icon('search', { size: 22 }),
        el('h3', { text: 'No match' }),
        el('p', {
          text: activeView
            ? `Nothing in "${viewLabel()}" matches that. Try another view.`
            : 'No pipeline matches that.',
        }),
      ),
    );
    return;
  }

  if (searching) {
    body.append(
      el('div', {
        class: 'pop-title',
        text: `${total} match${total === 1 ? '' : 'es'} - Enter opens the first`,
      }),
    );
  }

  let budget = shown;
  for (const section of sections) {
    if (budget <= 0) break;
    const slice = section.members.slice(0, budget);
    budget -= slice.length;

    if (section.title) body.append(el('div', { class: 'pop-title', text: section.title }));
    for (const entry of slice) body.append(row(entry.pipeline || entry, entry.hits || []));
  }

  const remaining = total - Math.min(shown, total);
  if (remaining === 0) return;

  body.append(
    el(
      'button',
      {
        class: 'pop-more',
        onclick: () => {
          shown += PAGE * 2;
          render();
        },
      },
      'Load more',
    ),
  );
}

/** Pipeline names are long and the popup is narrow, so most rows clip. */
function titleClippedRows() {
  applyOverflowTitles($('#body'));
}

function stat(kind, value, label, filter) {
  return el(
    'button',
    // Carrying the search matters most where the count is smallest: clicking
    // "Failing 1" under a search must not open the other 900.
    { class: `stat ${kind}`, onclick: () => openDashboard({ filter, search: query.trim() || null }) },
    el('span', { class: 'n', text: String(value) }),
    el('span', { class: 'l', text: label }),
  );
}

function row(pipeline, hits = []) {
  const status = pipelineStatus(pipeline);
  const tone = (STATUS[status] || STATUS.Unknown).tone;
  const run = pipeline._embedded?.instances?.[0];

  const name = el('span', { class: 'truncate', style: { flex: '1' } });
  name.append(highlighted(pipeline.name, hits));

  return el(
    'button',
    { class: `pop-row edge-${tone}`, onclick: () => openDashboard({ pipeline: pipeline.name }) },
    watched.includes(pipeline.name)
      ? icon('bell-filled', { size: 12 })
      : favorites.includes(pipeline.name) && icon('star-filled', { size: 12 }),
    name,
    run?.label &&
      el('span', { class: 'faint mono truncate', style: { maxWidth: '70px' }, text: run.label }),
    stageStrip(run?._embedded?.stages, { compact: true }),
    icon('chevron-right', { size: 13 }),
  );
}

function renderLoading() {
  clear($('#body')).append(
    el(
      'div',
      { class: 'empty' },
      icon('refresh', { size: 22, class: 'spin' }),
      el('p', { text: 'Loading pipelines...' }),
    ),
  );
}

function renderNotConnected() {
  clear($('#summary'));
  $('#controls').hidden = true;
  clear($('#body')).append(
    el(
      'div',
      { class: 'empty' },
      icon('layers', { size: 26 }),
      el('h3', { text: 'Not connected yet' }),
      el('p', {
        text: 'Point GoCD Lens at your GoCD server and it will read your pipelines straight from the API.',
      }),
      el('button', {
        class: 'btn btn-primary',
        text: 'Set it up',
        onclick: () => chrome.runtime.openOptionsPage(),
      }),
    ),
  );
  $('#open-dashboard').disabled = true;
}

function openDashboard(params = {}) {
  const search = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v != null)),
  ).toString();
  chrome.tabs.create({
    url: chrome.runtime.getURL(`src/dashboard/dashboard.html${search ? `?${search}` : ''}`),
  });
  window.close();
}
