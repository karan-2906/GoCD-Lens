/**
 * The dashboard shell: top bar, sidebar, filters, banners, and the refresh
 * loop. It decides which view fills the content area and re-renders on demand.
 */

import {
  $,
  el,
  icon,
  clear,
  send,
  toast,
  applyTheme,
  loadSprite,
  applyOverflowTitles,
} from '../common/ui.js';
import { pipelineStatus, timeAgo, freshnessAgo } from '../lib/status.js';
import {
  state,
  onRender,
  onFreshness,
  rerender,
  navigate,
  refresh,
  counts,
  matchingPipelines,
  loadViews,
  visibleGroups,
  selectView,
} from './state.js';
import { renderList } from './list-view.js';
import { renderPipeline, refreshOpenPipeline } from './pipeline-view.js';

const FILTERS = [
  { id: 'all', label: 'All', icon: 'list' },
  { id: 'failing', label: 'Failing', icon: 'alert', class: 'chip-fail' },
  { id: 'building', label: 'Running', icon: 'activity', class: 'chip-build' },
  { id: 'favorites', label: 'Starred', icon: 'star', class: 'chip-star' },
  { id: 'watched', label: 'Watching', icon: 'bell', class: 'chip-watch' },
  { id: 'paused', label: 'Paused', icon: 'pause' },
];

let pollTimer = null;
let freshnessTimer = null;

init();

async function init() {
  await loadSprite();
  decorateChrome();

  const bootstrap = await send('getState');
  state.connection = bootstrap.connection;
  state.hasPermission = bootstrap.hasPermission;
  state.settings = bootstrap.settings;
  state.favorites = bootstrap.favorites;
  state.watched = bootstrap.watched || [];
  state.recent = bootstrap.recent || [];
  state.expandedGroups = bootstrap.expandedGroups || [];
  state.activeView = bootstrap.settings.activeView ?? null;

  applyTheme(state.settings.theme);
  document.body.classList.toggle('rows', state.settings.density === 'compact');

  // Paint from the cache before the network answers -- the whole point when
  // GoCD is slow or gone.
  if (bootstrap.cache) {
    state.groups = bootstrap.cache.groups || [];
    state.pipelines = bootstrap.cache.pipelines || [];
    state.fetchedAt = bootstrap.cache.fetchedAt || 0;
    state.activeView = bootstrap.cache.view ?? state.activeView;
  }

  // The popup and notifications deep-link into a pipeline or a filter.
  const params = new URLSearchParams(location.search);
  const requested = params.get('pipeline');
  if (requested) state.route = { kind: 'pipeline', name: requested };
  const filter = params.get('filter');
  if (filter && FILTERS.some((f) => f.id === filter)) state.filter = filter;
  // The popup counts its tiles against its own search box, so a tile arriving
  // here without the search that shaped it would open a list nothing like the
  // number that was clicked.
  const search = params.get('search');
  if (search) state.search = search;

  onRender(render);
  onFreshness(paintFreshness);
  wireChrome();
  render();

  if (!state.connection) return;
  await refresh();
  await loadViews();
  await adoptDefaultView();
  startPolling();
}

/**
 * Where to start when nothing has been chosen yet.
 *
 * Your own starred pipelines are the best guess at what you came to look at; a
 * GoCD view is the next best; the whole instance is the last resort, and on a
 * large server not a useful place to land.
 */
async function adoptDefaultView() {
  if (state.activeView) return;
  // Adopting a default is not the user changing view: the popup and
  // notifications deep-link straight into a pipeline, and that route is already
  // set by the time this runs. Resetting it here would bounce them to the list.
  const options = { resetContext: false };
  if (state.favorites.length) return selectView('local:starred', options);
  if (state.views.length) return selectView(state.views[0].name, options);
}

// ------------------------------------------------------------------ chrome

function decorateChrome() {
  $('#search-icon').append(icon('search', { size: 15 }));
  $('#search-clear').append(icon('x', { size: 14 }));
  $('#group-search-icon').append(icon('search', { size: 13 }));
  $('#group-search-clear').append(icon('x', { size: 13 }));
  $('#refresh').append(icon('refresh'));
  $('#settings').append(icon('settings'));

  // A tooltip is worth the space only if it says more than the icon already
  // does, so each one names what a click will actually do.
  label('#refresh', 'Fetch the latest from GoCD now  (r)');
  label('#settings', 'Settings - connection, alerts, sounds and refresh rate');
  label('#search-clear', 'Clear the search  (Esc)');
  label('#group-search-clear', 'Clear the group filter  (Esc)');
  label('#home', 'Back to the top of this view');
  $('#viewer-close').append(icon('x'));
  $('#view-picker-icon').append(icon('list', { size: 14 }));
  paintThemeButton();
}

/**
 * What the page is actually showing, which is not the same as what is stored:
 * "system" resolves to whatever the OS is set to.
 */
function effectiveTheme() {
  const stored = state.settings?.theme ?? 'system';
  if (stored !== 'system') return stored;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function label(selector, text) {
  const node = $(selector);
  if (!node) return;
  node.title = text;
  node.setAttribute('aria-label', text);
}

function paintThemeButton() {
  const showing = effectiveTheme();
  const next = showing === 'dark' ? 'light' : 'dark';
  const button = clear($('#theme-toggle'));
  label('#theme-toggle', `Switch to the ${next} theme`);
  // The icon shows where the click goes, not where you already are.
  button.append(icon(next === 'light' ? 'sun' : 'moon'));
}

function wireChrome() {
  $('#home').addEventListener('click', (event) => {
    event.preventDefault();
    state.group = null;
    clearSearch({ focus: false });
    navigate({ kind: 'list' });
  });

  const search = $('#search');
  search.addEventListener('input', () => {
    state.search = search.value;
    if (state.route.kind !== 'list') state.route = { kind: 'list' };
    render();
  });

  // Enter opens the best match, so finding a pipeline is a few letters and Enter.
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const best = matchingPipelines()[0];
    if (!best) return;
    event.preventDefault();
    search.blur();
    navigate({ kind: 'pipeline', name: best.pipeline.name });
  });

  $('#search-clear').addEventListener('click', () => clearSearch());

  // The sidebar filter narrows the group list and nothing else, so it repaints
  // the sidebar rather than the whole page -- which also keeps the caret where
  // it is while a poll lands.
  const groupSearch = $('#group-search');
  groupSearch.addEventListener('input', () => {
    state.groupSearch = groupSearch.value;
    paintSearchBoxes();
    paintSidebar();
  });

  $('#group-search-clear').addEventListener('click', () => clearGroupSearch());

  // A card's name is only clipped once its actions take their space on hover,
  // so whether it has earned a tooltip cannot be answered when it is rendered.
  // One listener for the whole list re-measures the card you moved onto.
  let measured = null;
  $('#content').addEventListener('mouseover', (event) => {
    const card = event.target.closest?.('.card-p') || null;
    if (card === measured) return;
    measured = card;
    if (card) applyOverflowTitles(card);
  });

  $('#refresh').addEventListener('click', async () => {
    $('#refresh').querySelector('.icon')?.classList.add('spin');
    await refresh({ force: true });
    if (state.route.kind === 'pipeline') refreshOpenPipeline();
    $('#refresh').querySelector('.icon')?.classList.remove('spin');
  });

  $('#view-select').addEventListener('change', (event) => selectView(event.target.value));

  $('#settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

  $('#theme-toggle').addEventListener('click', async () => {
    // Flip against what is on screen rather than cycling system -> dark ->
    // light: on a machine set to dark, "system" and "dark" look identical, so
    // the first click appeared to do nothing and the button needed two.
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    state.settings = { ...state.settings, theme: next };
    paintThemeButton();
    await send('updateSettings', { patch: { theme: next } });
  });

  document.addEventListener('keydown', onKeydown);

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => applyOverflowTitles(), 150);
  });

  // Favourites, views and settings can change in the popup or the options page;
  // keep this tab in step rather than making the user reload it.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.favorites) state.favorites = changes.favorites.newValue || [];
    if (changes.watchedPipelines) state.watched = changes.watchedPipelines.newValue || [];
    if (changes.recentPipelines) state.recent = changes.recentPipelines.newValue || [];
    if (changes.expandedGroups) state.expandedGroups = changes.expandedGroups.newValue || [];
    if (changes.dashboardCache?.newValue) {
      // A background poll refreshed the cache; adopt it instead of refetching.
      const cache = changes.dashboardCache.newValue;
      state.groups = cache.groups || [];
      state.pipelines = cache.pipelines || [];
      state.fetchedAt = cache.fetchedAt || state.fetchedAt;
      state.activeView = cache.view ?? null;
      state.stale = false;
    }
    if (changes.settings) {
      state.settings = { ...state.settings, ...changes.settings.newValue };
      applyTheme(state.settings.theme);
      document.body.classList.toggle('rows', state.settings.density === 'compact');
      paintThemeButton();
      startPolling();
    }
    rerender();
  });
}

function clearSearch({ focus = true } = {}) {
  state.search = '';
  render();
  if (focus) $('#search').focus();
}

function clearGroupSearch({ focus = true } = {}) {
  state.groupSearch = '';
  paintSearchBoxes();
  paintSidebar();
  if (focus) $('#group-search').focus();
}

/**
 * Both boxes are painted from the state, not just written to it -- selecting a
 * view clears the search, and the input has to follow. Assigning unconditionally
 * would move the caret while someone is typing, so it only writes a difference.
 */
function paintSearchBoxes() {
  const search = $('#search');
  if (search.value !== state.search) search.value = state.search;
  $('#search-clear').hidden = !state.search;

  const groups = $('#group-search');
  if (groups.value !== state.groupSearch) groups.value = state.groupSearch;
  $('#group-search-clear').hidden = !state.groupSearch;
}

function onKeydown(event) {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);

  if (event.key === 'Escape') {
    if ($('#viewer').open) return; // the dialog closes itself
    if (typing) {
      if (event.target === $('#search') && state.search) clearSearch();
      else if (event.target === $('#group-search') && state.groupSearch) clearGroupSearch();
      else event.target.blur();
      return;
    }
    if (state.route.kind !== 'list') navigate({ kind: 'list' });
    return;
  }

  // The log viewer is modal and has its own keys; nothing here should reach
  // the dashboard behind it.
  if ($('#viewer').open || typing || event.metaKey || event.ctrlKey || event.altKey) return;

  if (event.key === '/') {
    event.preventDefault();
    $('#search').focus();
    $('#search').select();
  } else if (event.key === 'r') {
    $('#refresh').click();
  } else if (event.key === '?') {
    showShortcuts();
  }
}

function showShortcuts() {
  toast('/ search   -   Enter opens the best match   -   r refresh   -   Esc back', {
    tone: 'info',
    timeout: 5000,
  });
}

// ----------------------------------------------------------------- polling

function startPolling() {
  clearInterval(pollTimer);
  const seconds = state.settings?.pollSeconds || 0;
  if (seconds > 0) {
    pollTimer = setInterval(async () => {
      if (document.hidden) return; // a background tab does not need to poll
      await refresh({ quiet: true });
      refreshOpenPipeline();
    }, seconds * 1000);
  }

  // The "updated 12s ago" label counts seconds, so it ticks every second -- one
  // text node, and it is the only proof on screen that the data is live.
  clearInterval(freshnessTimer);
  freshnessTimer = setInterval(paintFreshness, 1000);
}

function paintFreshness() {
  const label = $('#freshness');
  if (!state.fetchedAt) {
    label.textContent = '';
    return;
  }
  label.textContent = `updated ${freshnessAgo(state.fetchedAt)}`;
  label.classList.toggle('stale', state.stale || Date.now() - state.fetchedAt > 180_000);
}

// ------------------------------------------------------------------ render

/** What was on screen last time, so a re-render can land you back where you were. */
let renderedRoute = null;

function render() {
  paintViewPicker();
  paintSearchBoxes();
  paintFilters();
  paintSidebar();
  paintBanners();
  paintFreshness();

  const content = $('#content');
  // Rebuilding the list throws away the scroll position. Keep it when the same
  // screen is being redrawn -- a poll landing while you are halfway down a group
  // should not snap you back to the top. Navigating somewhere new should.
  const sameScreen = renderedRoute === routeKey();
  const scrollTop = sameScreen ? content.scrollTop : 0;

  clear(content);
  if (!state.connection) {
    content.append(notConnected());
    return;
  }

  if (state.route.kind === 'pipeline') renderPipeline(content, state.route.name);
  else renderList(content);

  renderedRoute = routeKey();
  if (scrollTop) content.scrollTop = scrollTop;

  // Measured, not guessed: only text that is actually clipped gets a tooltip.
  applyOverflowTitles();
}

function routeKey() {
  return state.route.kind === 'pipeline' ? `pipeline:${state.route.name}` : 'list';
}

function paintFilters() {
  const host = clear($('#filters'));
  if (!state.connection) return;
  const totals = counts();

  for (const filter of FILTERS) {
    const active = state.filter === filter.id;
    host.append(
      el(
        'button',
        {
          class: `chip ${filter.class || ''}`.trim(),
          'aria-pressed': String(active),
          onclick: () => {
            state.filter = active && filter.id !== 'all' ? 'all' : filter.id;
            if (state.route.kind !== 'list') state.route = { kind: 'list' };
            render();
          },
        },
        icon(filter.icon, { size: 12 }),
        filter.label,
        el('span', { class: 'count', text: String(totals[filter.id] ?? 0) }),
      ),
    );
  }

  host.append(el('span', { class: 'spacer' }));

  // What else narrowed the list, each one removable from here.
  if (state.search.trim()) {
    const found = matchingPipelines().length;
    host.append(
      activeChip('search', `${found} match${found === 1 ? '' : 'es'}`, 'Clear the search', () =>
        clearSearch(),
      ),
    );
  }

  if (state.group) {
    host.append(
      activeChip('folder', state.group, 'Show every group', () => {
        state.group = null;
        render();
      }),
    );
  }

}

function activeChip(iconName, label, title, onClick) {
  return el(
    'button',
    { class: 'chip chip-active', title, onclick: onClick },
    icon(iconName, { size: 12 }),
    label,
    icon('x', { size: 12 }),
  );
}

/**
 * The user's GoCD views, as the centre control. GoCD filters by view and the
 * background worker enforces it again locally, so choosing one narrows the
 * list, the groups in the sidebar, the filter-chip counts, the toolbar badge
 * and the notifications together.
 *
 * There is no "all pipelines" entry: on a server with thousands of pipelines
 * the unfiltered set is not something anyone browses, and every view the user
 * built is a better starting point.
 */
function paintViewPicker() {
  const builtins = builtinViews();
  const picker = $('#view-picker');
  picker.hidden = state.views.length === 0 && builtins.length === 0;
  if (picker.hidden) return;

  const select = clear($('#view-select'));
  const known = [];

  // Yours first: the handful of pipelines you chose beats a list someone
  // configured on the server.
  for (const builtin of builtins) {
    known.push(builtin.value);
    select.append(
      el('option', {
        value: builtin.value,
        text: `${builtin.label}  (${builtin.count})`,
        selected: state.activeView === builtin.value,
      }),
    );
  }

  for (const view of state.views) {
    known.push(view.name);
    const size = view.pipelines?.length;
    select.append(
      el('option', {
        value: view.name,
        text: size ? `${view.name}  (${size})` : view.name,
        selected: state.activeView === view.name,
      }),
    );
  }

  // A view since deleted on the server would otherwise leave the control
  // showing the first entry while the data on screen came from another.
  if (state.activeView && !known.includes(state.activeView)) {
    select.append(el('option', { value: state.activeView, text: state.activeView, selected: true }));
  }
}

/**
 * The extension's own views. Shown only when they hold something, because an
 * empty "Starred" entry is just a question nobody asked.
 */
function builtinViews() {
  const entries = [];
  if (state.favorites.length) {
    entries.push({ value: 'local:starred', label: 'Starred', count: state.favorites.length });
  }
  if (state.watched.length) {
    entries.push({ value: 'local:watched', label: 'Watching', count: state.watched.length });
  }
  return entries;
}

function paintSidebar() {
  // The heading and the filter box are markup, not painted, so the caret
  // survives a poll landing mid-type. Only the rows below them are rebuilt.
  $('#sidebar-heading').hidden = !state.connection;
  $('#group-search-wrap').hidden = !state.connection;
  const host = clear($('#group-list'));
  if (!state.connection) return;

  // "All groups" is how you get back, so the filter never hides it.
  host.append(
    navItem({
      label: 'All groups',
      current: state.group === null,
      count: state.pipelines.length,
      onClick: () => {
        state.group = null;
        clearGroupSearch({ focus: false });
        navigate({ kind: 'list' });
      },
    }),
  );

  const groups = visibleGroups();
  for (const group of groups) {
    host.append(
      navItem({
        label: group.name,
        current: state.group === group.name,
        count: group.members.length,
        failing: group.members.some((p) => pipelineStatus(p) === 'Failed'),
        onClick: () => {
          state.group = group.name;
          navigate({ kind: 'list' });
        },
      }),
    );
  }

  if (groups.length === 0 && state.groupSearch.trim()) {
    host.append(el('div', { class: 'nav-empty', text: 'No group matches that.' }));
  }
}

function navItem({ label, current, count = null, failing = false, iconName = null, onClick }) {
  return el(
    'button',
    { class: 'nav-item', 'aria-current': String(current), onclick: onClick },
    iconName && icon(iconName, { size: 13 }),
    failing && el('span', { class: 'dot-fail' }),
    el('span', { class: 'truncate', text: label }),
    count != null && el('span', { class: 'nav-count', text: String(count) }),
  );
}

function paintBanners() {
  const host = clear($('#banners'));

  if (state.connection && !state.hasPermission) {
    host.append(
      banner('warn', 'lock', 'Your browser has not granted access to your GoCD server yet.', [
        ['Fix it in Settings', () => chrome.runtime.openOptionsPage()],
      ]),
    );
  }

  if (state.stale && state.pipelines.length > 0) {
    host.append(
      banner(
        'warn',
        'offline',
        `Showing the last data that loaded${state.fetchedAt ? ` (${timeAgo(state.fetchedAt)})` : ''}. ${state.loadError || ''}`.trim(),
        [
          ['Try again', () => refresh({ force: true })],
          ['Why?', () => openSettings('diagnostics')],
        ],
      ),
    );
  } else if (
    state.connection &&
    state.loadError &&
    state.loadError !== 'not-configured' &&
    state.pipelines.length === 0
  ) {
    host.append(
      banner('error', 'alert', state.loadError, [
        ['Try again', () => refresh({ force: true })],
        ['Settings', () => chrome.runtime.openOptionsPage()],
      ]),
    );
  }
}

/**
 * Open Settings at a particular section.
 *
 * `openOptionsPage()` takes no destination, so this opens the page directly
 * with a hash it knows how to honour. Sending someone to the top of a long
 * settings page and leaving them to find the thing you just mentioned is not
 * an answer to "why?".
 */
function openSettings(section = null) {
  const url = chrome.runtime.getURL(`src/setup/setup.html${section ? `#${section}` : ''}`);
  chrome.tabs.create({ url });
}

function banner(tone, iconName, message, actions = []) {
  return el(
    'div',
    { class: `banner banner-${tone}` },
    icon(iconName),
    el('span', { text: message }),
    actions.length &&
      el(
        'span',
        { class: 'banner-actions' },
        ...actions.map(([label, onClick]) =>
          el('button', { class: 'btn btn-sm', text: label, onclick: onClick }),
        ),
      ),
  );
}

function notConnected() {
  return el(
    'div',
    { class: 'empty' },
    icon('layers', { size: 32 }),
    el('h3', { text: 'Connect your GoCD server' }),
    el('p', {
      text: 'GoCD Lens reads your pipelines from the GoCD API and draws its own dashboard, so it keeps working when the GoCD web UI will not. It takes about thirty seconds to set up.',
    }),
    el('button', {
      class: 'btn btn-primary',
      text: 'Get started',
      onclick: () => chrome.runtime.openOptionsPage(),
    }),
  );
}
