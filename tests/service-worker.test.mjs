/**
 * The background worker, driven through its real message handler with a stubbed
 * Chrome and a stubbed network.
 *
 * What is worth pinning here is the behaviour a user notices and cannot easily
 * check: the badge count, notifying on a change rather than on a state, falling
 * back to the cache when GoCD is unreachable, and the fact that no reply to a
 * page ever carries the credential.
 */

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ------------------------------------------------------------ chrome stub

const storage = new Map();
const calls = {
  notifications: [],
  badgeText: [],
  badgeColor: [],
  titles: [],
  tabs: [],
  alarms: [],
  alarmsCleared: [],
  offscreen: [],
  sounds: [],
};
let offscreenExists = false;
let existingAlarm = null;
let audioBlocked = false;
/** When set, every pipeline gains a second stage that was never scheduled. */
let gated = false;
/** GoCD's view lookup is broken while the pipelines themselves answer fine. */
let viewsBroken = false;
/** Set to a promise to make the next dashboard request wait, as a slow server does. */
let holdDashboard = null;
let notificationLevel = 'granted';
let messageListener = null;

globalThis.chrome = {
  runtime: {
    id: 'gocd-lens-test',
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: {
      addListener(fn) {
        messageListener = fn;
      },
    },
    getURL: (path) => `chrome-extension://gocd-lens-test/${path}`,
    // The worker sends chimes to the offscreen document through this. The real
    // page answers, which is how the worker tells "played" apart from "that page
    // was not listening yet" -- so the stub answers too.
    async sendMessage(message) {
      if (message?.target !== 'offscreen') return undefined;
      if (!offscreenExists) throw new Error('Could not establish connection.');
      calls.sounds.push(message.payload?.name);
      return audioBlocked ? { ok: false, error: 'blocked by autoplay policy' } : { ok: true };
    },
  },
  storage: {
    local: {
      async get(key) {
        if (key == null) return Object.fromEntries(storage);
        const keys = Array.isArray(key) ? key : [key];
        const out = {};
        for (const k of keys) if (storage.has(k)) out[k] = storage.get(k);
        return out;
      },
      async set(items) {
        for (const [k, v] of Object.entries(items)) storage.set(k, v);
      },
      async remove(key) {
        for (const k of Array.isArray(key) ? key : [key]) storage.delete(k);
      },
      async clear() {
        storage.clear();
      },
    },
  },
  alarms: {
    async get() {
      return existingAlarm;
    },
    create(name, info) {
      calls.alarms.push({ name, info });
      existingAlarm = { name, periodInMinutes: info.periodInMinutes };
    },
    async clear(name) {
      calls.alarmsCleared.push(name);
      existingAlarm = null;
    },
    onAlarm: { addListener() {} },
  },
  notifications: {
    create(id, options) {
      calls.notifications.push({ id, ...options });
    },
    clear() {},
    async getPermissionLevel() {
      return notificationLevel;
    },
    onClicked: { addListener() {} },
  },
  action: {
    async setBadgeText({ text }) {
      calls.badgeText.push(text);
    },
    async setBadgeBackgroundColor({ color }) {
      calls.badgeColor.push(color);
    },
    async setTitle({ title }) {
      calls.titles.push(title);
    },
  },
  // A Manifest V3 worker has no DOM, so a chime goes through an offscreen
  // document. Only one may exist at a time, which is what this models.
  offscreen: {
    async hasDocument() {
      return offscreenExists;
    },
    async createDocument() {
      offscreenExists = true;
      calls.offscreen.push('created');
    },
  },
  tabs: {
    create(options) {
      calls.tabs.push(options);
    },
  },
  permissions: {
    async contains() {
      return true;
    },
  },
};

// ----------------------------------------------------------- network stub

const SERVER = 'https://gocd.example.com/go';

/**
 * Stage statuses per pipeline, swapped between polls to simulate a change. A
 * string is the one-stage case; an array spells a multi-stage run out.
 */
let world = { 'web-app': 'Passed', api: 'Passed' };
let etagCounter = 0;
let offline = false;
let requests = [];
/** Per-pipeline run counters, so a poll can tell one run from the next. */
let counters = {};

/** The 'Mine' view contains only web-app, the way a real personalized view would. */
const VIEWS = { Mine: ['web-app'] };

function dashboardBody(viewName = null) {
  const allowed = viewName ? new Set(VIEWS[viewName] || []) : null;
  const visible = Object.entries(world).filter(([name]) => !allowed || allowed.has(name));
  return {
    _embedded: {
      pipeline_groups: [{ name: 'core', pipelines: visible.map(([name]) => name) }],
      pipelines: visible.map(([name, status]) => ({
        name,
        pause_info: { paused: false },
        _embedded: {
          instances: [
            {
              counter: counters[name] ?? 1,
              label: String(counters[name] ?? 1),
              _embedded: {
                stages: Array.isArray(status)
                  ? status.map((each, i) => ({ name: `stage-${i + 1}`, status: each }))
                  : gated
                    ? [{ name: 'build', status }, { name: 'deploy', status: 'Unknown' }]
                    : [{ name: 'build', status }],
              },
            },
          ],
        },
      })),
    },
  };
}

globalThis.fetch = async (url, options = {}) => {
  requests.push({ url, options });
  if (offline) throw new TypeError('Failed to fetch');

  const path = new URL(url).pathname;
  const json = (body, init = {}) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });

  if (path === '/go/api/version') return json({ version: '23.5.0' });
  if (path === '/go/api/current_user') return json({ login_name: 'karan' });
  if (path === '/go/api/dashboard') {
    if (holdDashboard) {
      const gate = holdDashboard;
      holdDashboard = null;
      await gate;
    }
    const asked = new URL(url).searchParams.get('viewName');
    if (viewsBroken && asked) {
      return json({ message: 'Failed to resolve view' }, { status: 500 });
    }
    // GoCD filters by view server-side, so a view name means fewer pipelines
    // come back -- not that the extension hides some locally.
    const viewName = new URL(url).searchParams.get('viewName');
    const etag = `etag-${viewName || 'all'}-${etagCounter}`;
    if (options.headers?.['If-None-Match'] === etag) {
      return new Response('', { status: 304, headers: { ETag: etag } });
    }
    return json(dashboardBody(viewName), {
      headers: { 'Content-Type': 'application/json', ETag: etag },
    });
  }
  if (path === '/go/api/internal/pipeline_selection') {
    return json({
      filters: [{ name: 'Mine', type: 'whitelist', state: [], pipelines: ['web-app'] }],
    });
  }
  if (path === '/') return new Response('<html></html>', { status: 200 });
  return json({ message: 'no route' }, { status: 404 });
};

await import('../src/background/service-worker.js');

/** Invoke the worker exactly as a page does, and unwrap its reply. */
function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const kept = messageListener({ type, payload }, { id: chrome.runtime.id }, (response) => {
      if (!response) return reject(new Error('no response'));
      if (!response.ok) {
        const err = new Error(response.error);
        err.kind = response.kind;
        return reject(err);
      }
      resolve(response.data);
    });
    if (kept !== true) reject(new Error(`handler for ${type} did not keep the channel open`));
  });
}

const connect = () =>
  send('saveConnection', {
    connection: { serverUrl: SERVER, authMode: 'token', token: 'super-secret-token-abcd' },
  });

beforeEach(() => {
  storage.clear();
  offscreenExists = false;
  existingAlarm = null;
  audioBlocked = false;
  gated = false;
  viewsBroken = false;
  holdDashboard = null;
  notificationLevel = 'granted';
  for (const key of Object.keys(calls)) calls[key].length = 0;
  world = { 'web-app': 'Passed', api: 'Passed' };
  etagCounter = 0;
  offline = false;
  requests = [];
  counters = {};
});

// ------------------------------------------------------------------ tests

test('an unknown message is refused rather than silently ignored', async () => {
  await assert.rejects(send('definitelyNotAHandler'), /Unknown request/);
});

test('a message from anywhere but this extension is dropped', () => {
  const kept = messageListener({ type: 'getState' }, { id: 'some-other-extension' }, () => {
    assert.fail('a foreign sender must not be answered');
  });
  assert.equal(kept, false);
});

test('saving a connection verifies it before storing it', async () => {
  const result = await connect();
  assert.equal(result.version, '23.5.0');
  assert.equal(result.user, 'karan');
  assert.ok(
    requests.some((r) => r.url.endsWith('/api/version')),
    'a typo should surface at setup, not as an empty dashboard later',
  );
});

test('a connection that GoCD rejects is not stored', async () => {
  offline = true;
  await assert.rejects(connect(), (err) => err.kind === 'network');
  assert.equal(storage.get('connection'), undefined);
});

test('the state a page receives never contains the credential', async () => {
  await connect();
  const state = await send('getState');
  const serialised = JSON.stringify(state);
  assert.ok(!serialised.includes('super-secret-token'), `the token reached a page: ${serialised}`);
  assert.equal(state.connection.serverUrl, SERVER);
  assert.equal(state.connection.hasSecret, true);
});

test('the first load is silent, so connecting does not fire a wall of alerts', async () => {
  await connect();
  world = { 'web-app': 'Failed', api: 'Passed' };
  await send('refresh', { force: true });
  assert.deepEqual(calls.notifications, [], 'there is no previous state to have changed from');
});

test('the badge counts failing pipelines and colours itself red', async () => {
  await connect();
  world = { 'web-app': 'Failed', api: 'Failed' };
  await send('refresh', { force: true });
  assert.equal(calls.badgeText.at(-1), '2');
  assert.equal(calls.badgeColor.at(-1), '#DC2626');
  assert.match(calls.titles.at(-1), /2 failing/);
});

test('with nothing failing, the badge shows running work instead', async () => {
  await connect();
  world = { 'web-app': 'Building', api: 'Passed' };
  await send('refresh', { force: true });
  assert.equal(calls.badgeText.at(-1), '1');
  assert.equal(calls.badgeColor.at(-1), '#2563EB');
});

test('an all-green server clears the badge rather than showing a zero', async () => {
  await connect();
  await send('refresh', { force: true });
  assert.equal(calls.badgeText.at(-1), '');
  // "nothing failing" rather than "all green": a run still going is neither.
  assert.match(calls.titles.at(-1), /nothing failing/);
});

test('a pipeline turning red notifies once, and staying red stays quiet', async () => {
  await connect();
  await send('toggleFavorite', { name: 'web-app' });
  await send('refresh', { force: true }); // establishes the baseline

  world = { 'web-app': 'Failed', api: 'Passed' };
  etagCounter += 1;
  await send('refresh', { force: true });
  assert.equal(calls.notifications.length, 1);
  assert.match(calls.notifications[0].title, /failed/i);
  assert.match(calls.notifications[0].message, /web-app/);

  // Same state on the next poll: a pipeline red all week must not nag.
  etagCounter += 1;
  await send('refresh', { force: true });
  assert.equal(calls.notifications.length, 1, 'notify on the change, not on the state');
});

test('going back to green says so', async () => {
  await connect();
  await send('toggleFavorite', { name: 'web-app' });
  await send('refresh', { force: true });

  world = { 'web-app': 'Failed', api: 'Passed' };
  etagCounter += 1;
  await send('refresh', { force: true });

  world = { 'web-app': 'Passed', api: 'Passed' };
  etagCounter += 1;
  await send('refresh', { force: true });

  assert.equal(calls.notifications.length, 2);
  assert.match(calls.notifications[1].title, /green/i);
});

test('a starred pipeline is alerted on, an unstarred one is not', async () => {
  await connect();
  await send('toggleFavorite', { name: 'web-app' });
  await send('refresh', { force: true });

  await advance({ 'web-app': 'Passed', api: 'Failed' });
  assert.deepEqual(calls.notifications, [], 'api is neither starred nor watched');

  await advance({ 'web-app': 'Failed', api: 'Failed' });
  assert.equal(calls.notifications.length, 1);
  assert.match(calls.notifications[0].message, /web-app/);
});

test('the starred alert covers both directions and nothing in between', async () => {
  // Red on the way down, green on the way back, silence while it sits at either.
  await connect();
  await send('toggleFavorite', { name: 'web-app' });
  await send('refresh', { force: true });

  await advance({ 'web-app': 'Failed', api: 'Passed' });
  assert.equal(calls.notifications.length, 1, 'turning red');

  etagCounter += 1;
  await send('refresh', { force: true });
  assert.equal(calls.notifications.length, 1, 'still red says nothing new');

  await advance({ 'web-app': 'Passed', api: 'Passed' });
  assert.equal(calls.notifications.length, 2);
  assert.match(calls.notifications[1].title, /green/i);
});

test('the starred alert can be switched off on its own', async () => {
  await connect();
  await send('updateSettings', { patch: { notifyStarred: false } });
  await send('toggleFavorite', { name: 'web-app' });
  await send('refresh', { force: true });

  await advance({ 'web-app': 'Failed', api: 'Passed' });
  assert.deepEqual(calls.notifications, [], 'starring alone no longer interrupts');
});

test('turning notifications off keeps the badge but stops the popups', async () => {
  await connect();
  await send('updateSettings', { patch: { notifications: false } });
  await send('refresh', { force: true });

  world = { 'web-app': 'Failed', api: 'Passed' };
  etagCounter += 1;
  await send('refresh', { force: true });

  assert.deepEqual(calls.notifications, []);
  assert.equal(calls.badgeText.at(-1), '1', 'the badge is still the quiet signal');
});

test('polls inside one interval share a single fetch instead of stacking up', async () => {
  // Several tabs, a popup and the background alarm all poll on their own
  // timers. Without coalescing, three open tabs would mean three times the load
  // on GoCD for exactly the same answer.
  await connect();
  await send('refresh', { force: true });
  requests = [];

  const second = await send('refresh', {});
  const third = await send('refresh', {});

  assert.equal(second.pipelines.length, 2, 'the cache still answers in full');
  assert.equal(third.pipelines.length, 2);
  assert.deepEqual(
    requests.filter((r) => r.url.includes('/api/dashboard')),
    [],
    'no request should have reached GoCD at all',
  );
});

test('a manual refresh always reaches the server, however recent the cache', async () => {
  await connect();
  await send('refresh', { force: true });
  requests = [];

  await send('refresh', { force: true });
  assert.equal(
    requests.filter((r) => r.url.includes('/api/dashboard')).length,
    1,
    'pressing refresh must mean refresh',
  );
});

test('once the cache is stale the ETag is sent, so an unchanged server costs a 304', async () => {
  await connect();
  await send('refresh', { force: true });

  // Age the cache past the coalescing window.
  const cache = storage.get('dashboardCache');
  storage.set('dashboardCache', { ...cache, fetchedAt: Date.now() - 120_000 });
  requests = [];

  const again = await send('refresh', {});
  assert.equal(again.pipelines.length, 2, 'a 304 must still answer with the cached data');
  const dashboardRequest = requests.find((r) => r.url.includes('/api/dashboard'));
  assert.equal(dashboardRequest.options.headers['If-None-Match'], 'etag-all-0');
});

test('when GoCD is unreachable the cache is served, flagged as stale', async () => {
  await connect();
  world = { 'web-app': 'Failed', api: 'Passed' };
  await send('refresh', { force: true });

  offline = true;
  const result = await send('refresh', { force: true });

  assert.equal(result.stale, true);
  assert.equal(result.pipelines.length, 2, 'the last good data stays browsable');
  assert.match(result.error, /VPN|permission|Cannot reach/);
  assert.equal(calls.badgeText.at(-1), '!', 'and the badge says the data is old');
});

test('with no cache and no server, the failure is reported rather than swallowed', async () => {
  await connect();
  offline = true;
  await assert.rejects(send('refresh', { force: true }), (err) => err.kind === 'network');
});

test('disconnecting clears the credential, the cache and the badge', async () => {
  await connect();
  await send('refresh', { force: true });
  await send('disconnect');

  assert.equal(storage.get('connection'), undefined);
  assert.equal(storage.get('dashboardCache'), undefined);
  assert.equal(calls.badgeText.at(-1), '');

  await assert.rejects(send('history', { pipeline: 'web-app' }), (err) => err.kind === 'config');
});

test('editing a connection without retyping the token keeps the stored one', async () => {
  await connect();
  await send('saveConnection', {
    connection: { serverUrl: SERVER, authMode: 'token', keepExistingSecret: true },
  });
  assert.equal(storage.get('connection').token, 'super-secret-token-abcd');
  assert.equal(storage.get('connection').keepExistingSecret, undefined, 'the flag is not persisted');
});

test('switching auth mode does not carry the old secret across', async () => {
  await connect();
  await send('saveConnection', {
    connection: { serverUrl: SERVER, authMode: 'session', keepExistingSecret: true },
  });
  const stored = storage.get('connection');
  assert.equal(stored.authMode, 'session');
  assert.equal(stored.token, undefined, 'a token must not linger behind a mode that does not use one');
});

test('diagnostics separate the API from the web UI', async () => {
  await connect();
  const report = await send('diagnose');
  const ids = report.probes.map((p) => p.id);
  assert.deepEqual(ids, ['version', 'identity', 'dashboard', 'webui']);
  assert.ok(report.probes.every((p) => typeof p.ms === 'number'));
  assert.match(report.probes.find((p) => p.id === 'dashboard').detail, /2 pipelines/);
});

test('with nothing picked out, the badge counts the open view', async () => {
  await connect();
  world = { 'web-app': 'Failed', api: 'Failed' };
  await send('refresh', { force: true });
  assert.equal(calls.badgeText.at(-1), '2');
  assert.match(calls.titles.at(-1), /2 failing across every pipeline/);
});

test('a pipeline being re-run reads as running, not as failing', async () => {
  await connect();
  // The shape a re-run leaves on a run: the stage that failed is still on it,
  // and a later stage is moving again. GoCD halts at a failure, so this state
  // can only mean somebody restarted it.
  world = { 'web-app': ['Passed', 'Failed', 'Building'], api: 'Passed' };
  await send('refresh', { force: true });

  assert.equal(calls.badgeText.at(-1), '1');
  assert.equal(calls.badgeColor.at(-1), '#2563EB', 'it sat red with nothing to count');
  assert.match(calls.titles.at(-1), /1 running/);
});

test('a search typed into the popup narrows the badge with it', async () => {
  await connect();
  world = { 'web-app': 'Failed', api: 'Failed' };
  await send('refresh', { force: true });
  assert.equal(calls.badgeText.at(-1), '2');

  // Repainted on the keystroke, not at the next poll -- with background
  // checking off, "the next poll" can be never.
  await send('setPopupSearch', { query: 'web' });
  assert.equal(calls.badgeText.at(-1), '1');
  assert.match(calls.titles.at(-1), /matching "web"/, 'a narrowed badge has to say so');

  await send('setPopupSearch', { query: '' });
  assert.equal(calls.badgeText.at(-1), '2');
});

test('the badge can be told to follow your watch list', async () => {
  await connect();
  await send('updateSettings', { patch: { badgeSource: 'watched' } });
  world = { 'web-app': 'Failed', api: 'Failed' };
  await send('toggleWatched', { name: 'web-app' });
  await send('refresh', { force: true });

  assert.equal(calls.badgeText.at(-1), '1', 'api is failing too, but is not watched');
  assert.match(calls.titles.at(-1), /1 failing of 1 watching/);
});

test('running outranks failing on the badge', async () => {
  // The badge is on screen all day, so it answers "is anything happening now".
  // A failure persists for hours and is already plain elsewhere; a badge stuck
  // on it all week says nothing new.
  await connect();
  await send('updateSettings', { patch: { badgeSource: 'view' } });

  world = { 'web-app': 'Failed', api: 'Building' };
  await send('refresh', { force: true });

  assert.equal(calls.badgeText.at(-1), '1', 'the one that is running, not the one that is red');
  assert.equal(calls.badgeColor.at(-1), '#2563EB');
  assert.match(calls.titles.at(-1), /1 running, 1 failing/, 'and the tooltip still reports both');
});

test('with nothing running, the failure count takes over', async () => {
  await connect();
  await send('updateSettings', { patch: { badgeSource: 'view' } });

  world = { 'web-app': 'Failed', api: 'Failed' };
  await send('refresh', { force: true });

  assert.equal(calls.badgeText.at(-1), '2');
  assert.equal(calls.badgeColor.at(-1), '#DC2626');
});

test('failing shows red, and with nothing failing the running count shows blue', async () => {
  await connect();
  await send('updateSettings', { patch: { badgeSource: 'watched' } });
  await send('toggleWatched', { name: 'web-app' });

  world = { 'web-app': 'Failed', api: 'Passed' };
  await send('refresh', { force: true });
  assert.equal(calls.badgeColor.at(-1), '#DC2626');

  await advance({ 'web-app': 'Building', api: 'Passed' });
  assert.equal(calls.badgeText.at(-1), '1');
  assert.equal(calls.badgeColor.at(-1), '#2563EB');
  assert.match(calls.titles.at(-1), /1 running of 1 watching/);
});

test('a watched pipeline the open view hides is declared, not quietly dropped', async () => {
  // The badge can only count what the last payload contained.
  await connect();
  await send('updateSettings', { patch: { badgeSource: 'watched' } });
  await send('toggleWatched', { name: 'web-app' });
  await send('toggleWatched', { name: 'api' });
  world = { 'web-app': 'Failed', api: 'Failed' };

  // The 'Mine' view contains web-app only.
  await send('refresh', { force: true, view: 'Mine' });

  assert.equal(calls.badgeText.at(-1), '1');
  assert.match(calls.titles.at(-1), /1 not in the current view/);
});

test('the badge can be pinned to the open view instead', async () => {
  await connect();
  await send('updateSettings', { patch: { badgeSource: 'view' } });
  await send('toggleWatched', { name: 'web-app' });
  world = { 'web-app': 'Failed', api: 'Failed' };
  await send('refresh', { force: true });

  assert.equal(calls.badgeText.at(-1), '2', 'both failures count again');
});

// -------------------------------------------------- personalized GoCD views

test('picking a view while a poll is in flight is not answered with the view you left', async () => {
  await connect();
  // 'Mine' holds web-app only, so the failure is in the view being left and not
  // in the one being picked: the badge has to go from 1 to nothing.
  world = { 'web-app': 'Passed', api: 'Failed' };
  await send('refresh', { force: true });
  assert.equal(calls.badgeText.at(-1), '1');

  // A dashboard tab, the popup and the alarm all poll on their own timers, so
  // on a slow server there is usually a request in the air when you reach for
  // the picker.
  let release;
  holdDashboard = new Promise((resolve) => {
    release = resolve;
  });
  const polling = send('refresh', { force: true });
  const picking = send('refresh', { force: true, view: 'Mine' });
  release();
  await polling;
  const picked = await picking;

  assert.equal(picked.view, 'Mine');
  assert.deepEqual(
    picked.pipelines.map((p) => p.name),
    ['web-app'],
  );
  const state = await send('getState');
  assert.equal(state.settings.activeView, 'Mine', 'the choice was never saved');
  assert.equal(calls.badgeText.at(-1), '', 'the badge kept counting the view you left');
});

test('selecting a view narrows what the server sends back', async () => {
  await connect();
  const all = await send('refresh', { force: true });
  assert.equal(all.pipelines.length, 2);
  assert.equal(all.view, null);

  const mine = await send('refresh', { force: true, view: 'Mine' });
  assert.equal(mine.pipelines.length, 1, 'GoCD filters it, so fewer pipelines arrive');
  assert.equal(mine.pipelines[0].name, 'web-app');
  assert.equal(mine.view, 'Mine');
});

test('the chosen view survives a refresh that does not mention one', async () => {
  await connect();
  await send('refresh', { force: true, view: 'Mine' });

  // This is what the poll timer and the background alarm send.
  const polled = await send('refresh', { force: true });
  assert.equal(polled.view, 'Mine', 'omitting the view must mean "keep it", not "reset it"');
  assert.equal(polled.pipelines.length, 1);
});

test('you can get back to all pipelines after choosing a view', async () => {
  // Regression: null used to fall through to the cached view, so "All
  // pipelines" was a one-way door.
  await connect();
  await send('refresh', { force: true, view: 'Mine' });

  const back = await send('refresh', { force: true, view: null });
  assert.equal(back.view, null);
  assert.equal(back.pipelines.length, 2, 'every pipeline is visible again');
});

test('the chosen view is remembered across restarts', async () => {
  await connect();
  await send('refresh', { force: true, view: 'Mine' });

  const state = await send('getState');
  assert.equal(state.settings.activeView, 'Mine', 'a page reload should not lose the selection');
});

test('a cache built for one view never answers for another', async () => {
  await connect();
  await send('refresh', { force: true, view: 'Mine' });

  requests = [];
  // Not forced: without the view check this would send the 'Mine' ETag, take a
  // 304, and hand back the wrong pipeline list.
  const all = await send('refresh', { view: null });
  assert.equal(all.pipelines.length, 2);
  const dashboardRequest = requests.find((r) => r.url.includes('/api/dashboard'));
  assert.equal(dashboardRequest.options.headers['If-None-Match'], undefined);
});

test('switching views does not fire notifications for pipelines that merely reappeared', async () => {
  await connect();
  world = { 'web-app': 'Passed', api: 'Failed' };
  await send('refresh', { force: true });

  calls.notifications.length = 0;
  await send('refresh', { force: true, view: 'Mine' }); // api drops out of sight
  await send('refresh', { force: true, view: null }); // and comes back, still red

  assert.deepEqual(calls.notifications, [], 'coming back into view is not a change of state');
});

test('the badge follows the active view, because that is what you are watching', async () => {
  await connect();
  world = { 'web-app': 'Failed', api: 'Failed' };
  await send('refresh', { force: true });
  assert.equal(calls.badgeText.at(-1), '2');

  await send('refresh', { force: true, view: 'Mine' });
  assert.equal(calls.badgeText.at(-1), '1', 'only the view\u2019s pipelines are counted');
});

// ------------------------------------------------- the watch list

/**
 * Move the world on one poll.
 *
 * A run counter goes up when a pipeline *starts*, so only pipelines that begin
 * building get a new one -- exactly as GoCD behaves. `alsoStarted` covers the
 * case a poll cannot see directly: a run that began and ended in the gap.
 */
async function advance(next, { alsoStarted = [] } = {}) {
  for (const [name, status] of Object.entries(next)) {
    const wasBuilding = world[name] === 'Building';
    if ((status === 'Building' && !wasBuilding) || alsoStarted.includes(name)) {
      counters[name] = (counters[name] ?? 1) + 1;
    }
  }
  world = next;
  etagCounter += 1;
  await send('refresh', { force: true });
}

test('watching a pipeline reports the run starting', async () => {
  await connect();
  await send('toggleWatched', { name: 'web-app' });
  await send('refresh', { force: true });

  await advance({ 'web-app': 'Building', api: 'Passed' });

  assert.equal(calls.notifications.length, 1);
  assert.match(calls.notifications[0].title, /started/i);
  assert.match(calls.notifications[0].message, /web-app/);
  assert.deepEqual(calls.sounds, ['start']);
});

test('and reports it finishing, saying it passed', async () => {
  await connect();
  await send('toggleWatched', { name: 'web-app' });
  await send('refresh', { force: true });

  await advance({ 'web-app': 'Building', api: 'Passed' });
  calls.notifications.length = 0;
  calls.sounds.length = 0;

  await advance({ 'web-app': 'Passed', api: 'Passed' });

  assert.equal(calls.notifications.length, 1);
  assert.match(calls.notifications[0].title, /passed/i);
  assert.match(calls.notifications[0].message, /No failures/i);
  assert.deepEqual(calls.sounds, ['success']);
});

test('a failure says so, names the stage, and stays on screen', async () => {
  await connect();
  await send('toggleWatched', { name: 'web-app' });
  await send('refresh', { force: true });

  await advance({ 'web-app': 'Building', api: 'Passed' });
  calls.notifications.length = 0;
  calls.sounds.length = 0;

  await advance({ 'web-app': 'Failed', api: 'Passed' });

  const [alert] = calls.notifications;
  assert.match(alert.title, /failed/i);
  assert.match(alert.message, /build/, 'the stage that went red is worth naming');
  assert.equal(alert.requireInteraction, true, 'a failure should not scroll past unseen');
  assert.equal(alert.priority, 2);
  assert.deepEqual(calls.sounds, ['failure']);
});

test('a run that starts and finishes between two polls is still reported', async () => {
  // Background polls are a minute apart; plenty of pipelines are quicker.
  // Comparing statuses alone would see Passed then Passed and say nothing.
  await connect();
  await send('toggleWatched', { name: 'web-app' });
  await send('refresh', { force: true });

  await advance({ 'web-app': 'Passed', api: 'Passed' }, { alsoStarted: ['web-app'] });

  assert.equal(calls.notifications.length, 1, 'the new run counter is the only evidence left');
  assert.match(calls.notifications[0].title, /passed/i);
});

test('an unwatched pipeline running is not announced', async () => {
  await connect();
  await send('toggleWatched', { name: 'web-app' });
  await send('refresh', { force: true });

  await advance({ 'web-app': 'Passed', api: 'Building' });
  assert.deepEqual(calls.notifications, [], 'api was never watched');
});

test('a watched pipeline is not also alerted on by the broader red alert', async () => {
  await connect();
  await send('toggleWatched', { name: 'web-app' });
  await send('refresh', { force: true });

  await advance({ 'web-app': 'Failed', api: 'Passed' });
  assert.equal(calls.notifications.length, 1, 'one failure, one notification');
});

test('a burst of finishes makes one sound, the most serious one', async () => {
  await connect();
  await send('toggleWatched', { name: 'web-app' });
  await send('toggleWatched', { name: 'api' });
  await send('refresh', { force: true });

  await advance({ 'web-app': 'Building', api: 'Building' });
  calls.sounds.length = 0;
  calls.notifications.length = 0;

  await advance({ 'web-app': 'Passed', api: 'Failed' });
  assert.equal(calls.notifications.length, 2, 'both are still reported');
  assert.deepEqual(calls.sounds, ['failure'], 'but chimes must not overlap');
});

test('turning the sound off keeps the notification', async () => {
  await connect();
  await send('updateSettings', { patch: { sound: false } });
  await send('toggleWatched', { name: 'web-app' });
  await send('refresh', { force: true });

  await advance({ 'web-app': 'Building', api: 'Passed' });
  assert.equal(calls.notifications.length, 1);
  assert.deepEqual(calls.sounds, []);
});

test('turning notifications off silences the watch list entirely', async () => {
  await connect();
  await send('updateSettings', { patch: { notifications: false } });
  await send('toggleWatched', { name: 'web-app' });
  await send('refresh', { force: true });

  await advance({ 'web-app': 'Failed', api: 'Passed' });
  assert.deepEqual(calls.notifications, []);
  assert.deepEqual(calls.sounds, []);
});

test('the offscreen document is created once and then reused', async () => {
  await connect();
  await send('toggleWatched', { name: 'web-app' });
  await send('refresh', { force: true });

  await advance({ 'web-app': 'Building', api: 'Passed' });
  await advance({ 'web-app': 'Passed', api: 'Passed' });

  assert.equal(calls.offscreen.length, 1, 'only one offscreen document may exist at a time');
  assert.equal(calls.sounds.length, 2);
});

test('watching and starring are separate lists', async () => {
  await connect();
  await send('toggleWatched', { name: 'web-app' });
  const state = await send('getState');
  assert.deepEqual(state.watched, ['web-app']);
  assert.deepEqual(state.favorites, [], 'watching something must not star it');
});

test('the alarm follows the background interval on its own', async () => {
  await connect();
  calls.alarms.length = 0;

  // No notify tick: the badge is reason enough to check.
  await send('updateSettings', { patch: { backgroundMinutes: 15 } });
  assert.equal(calls.alarms.at(-1)?.info.periodInMinutes, 15);

  await send('updateSettings', { patch: { backgroundMinutes: 60 } });
  assert.equal(calls.alarms.at(-1)?.info.periodInMinutes, 60);

  // Never means no alarm at all, not an alarm that does nothing.
  calls.alarms.length = 0;
  await send('updateSettings', { patch: { backgroundMinutes: 0 } });
  assert.deepEqual(calls.alarms, [], 'nothing should be scheduled');
  assert.deepEqual(calls.alarmsCleared, ['gocd-lens-poll']);
});

test('the badge follows a bell straight away', async () => {
  await connect();
  await send('updateSettings', { patch: { badgeSource: 'watched' } });
  world = { 'web-app': 'Failed', api: 'Failed' };
  await send('refresh', { force: true });

  await send('toggleWatched', { name: 'web-app' });
  assert.equal(calls.badgeText.at(-1), '1', 'without waiting for the next poll');

  await send('toggleWatched', { name: 'api' });
  assert.equal(calls.badgeText.at(-1), '2');
});

test('the badge source can be pinned to watching or starred explicitly', async () => {
  await connect();
  await send('toggleWatched', { name: 'web-app' });
  await send('toggleFavorite', { name: 'api' });
  world = { 'web-app': 'Failed', api: 'Failed' };
  await send('refresh', { force: true });

  await send('updateSettings', { patch: { badgeSource: 'starred' } });
  assert.match(calls.titles.at(-1), /of 1 starred/, 'a setting change repaints at once');

  await send('updateSettings', { patch: { badgeSource: 'watched' } });
  assert.match(calls.titles.at(-1), /of 1 watching/);
});

test('an explicit source with an empty list says so instead of counting everything', async () => {
  // Choosing "only what I am watching" and watching nothing should not silently
  // widen to every pipeline on the instance.
  await connect();
  world = { 'web-app': 'Failed', api: 'Failed' };
  await send('refresh', { force: true });

  await send('updateSettings', { patch: { badgeSource: 'watched' } });
  assert.equal(calls.badgeText.at(-1), '');
  assert.match(calls.titles.at(-1), /nothing watching yet/i);
});

test('a chime blocked by the browser does not cost the notification', async () => {
  // Chrome's autoplay policy can refuse. The alert is the part that matters.
  audioBlocked = true;
  await connect();
  await send('toggleWatched', { name: 'web-app' });
  await send('refresh', { force: true });

  await advance({ 'web-app': 'Failed', api: 'Passed' }, { alsoStarted: ['web-app'] });
  assert.equal(calls.notifications.length, 1, 'the notification still arrives');
});

test('a preview reports why it was silent instead of looking broken', async () => {
  audioBlocked = true;
  await connect();
  const result = await send('previewSound', { name: 'failure' });
  assert.equal(result.ok, false);
  assert.match(result.error, /autoplay/);
  assert.deepEqual(calls.sounds, ['failure'], 'the chime was still asked for');
});

test('a preview plays even with chimes switched off, so you can audition first', async () => {
  // Deciding whether you want a sound on requires hearing it.
  await connect();
  await send('updateSettings', { patch: { sound: false } });

  const result = await send('previewSound', { name: 'start' });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.sounds, ['start']);

  // But a real event stays silent.
  calls.sounds.length = 0;
  await send('toggleWatched', { name: 'web-app' });
  await send('refresh', { force: true });
  await advance({ 'web-app': 'Building', api: 'Passed' });
  assert.deepEqual(calls.sounds, []);
});

test('Chrome\u2019s notification setting is readable, so the page can warn', async () => {
  await connect();
  assert.deepEqual(await send('notificationStatus'), { level: 'granted' });

  notificationLevel = 'denied';
  assert.deepEqual(await send('notificationStatus'), { level: 'denied' });
});

test('a test notification is sent for real, because the OS cannot be asked', async () => {
  // Chrome can report "granted" while macOS silences it entirely, so trying one
  // and looking is the only check that covers both.
  await connect();
  const result = await send('testNotification');

  assert.equal(result.ok, true);
  assert.equal(calls.notifications.length, 1);
  assert.match(calls.notifications[0].title, /works/i);
  assert.deepEqual(calls.sounds, ['success'], 'and it makes the sound a real one would');
});

test('a test notification is silent when chimes are off, like a real one', async () => {
  // A test that behaves differently from the thing it is testing is not a test.
  await connect();
  await send('updateSettings', { patch: { sound: false } });

  await send('testNotification');
  assert.equal(calls.notifications.length, 1, 'the notification still appears');
  assert.deepEqual(calls.sounds, [], 'but it does not make a noise you did not ask for');
});

test('a run parked at an approval gate is not counted as running', async () => {
  // Its later stages never started, which rolls up to Waiting. That is not the
  // same as in flight, and the badge used to put a number on it for days.
  await connect();
  await send('updateSettings', { patch: { badgeSource: 'view' } });

  world = { 'web-app': 'Passed', api: 'Passed' };
  await send('refresh', { force: true });

  // Second stage exists but was never scheduled: passed, then nothing.
  gated = true;
  etagCounter += 1;
  await send('refresh', { force: true });

  assert.equal(calls.badgeText.at(-1), '', 'nothing is running and nothing is failing');
});

// ------------------------------------------- when GoCD's views break, not GoCD

test('a broken view lookup falls back to the unfiltered dashboard', async () => {
  // Seen in production: `?viewName=...` started failing and took the GoCD web
  // UI down with it, while the pipelines themselves were answering perfectly.
  await connect();
  await send('views'); // caches the definitions, as opening the dashboard does
  await send('refresh', { force: true, view: 'Mine' });
  assert.equal(calls.badgeText.at(-1) !== '!', true, 'healthy to begin with');

  viewsBroken = true;
  etagCounter += 1;
  const result = await send('refresh', { force: true });

  assert.ok(!result.stale, 'this is fresh data, not the cache');
  assert.equal(result.view, 'Mine', 'still the view you chose');
  assert.deepEqual(
    result.pipelines.map((p) => p.name),
    ['web-app'],
    'filtered locally from the cached definition, exactly as before',
  );
});

test('it does not retry unfiltered when the view is not one we know', async () => {
  // Without a cached definition the unfiltered payload would be both wrong and
  // the most expensive request the extension can make.
  await connect();
  await send('refresh', { force: true, view: 'Unknown view' });
  requests = [];

  viewsBroken = true;
  etagCounter += 1;
  const result = await send('refresh', { force: true });

  assert.equal(result.stale, true, 'the cache answers instead');
  assert.equal(
    requests.filter((r) => r.url.includes('/api/dashboard')).length,
    1,
    'one attempt, not two',
  );
});

test('a dead server is not retried either', async () => {
  await connect();
  await send('views');
  await send('refresh', { force: true, view: 'Mine' });
  requests = [];

  offline = true;
  const result = await send('refresh', { force: true });
  assert.equal(result.stale, true);
  assert.equal(requests.length, 1, 'no point asking a second time');
});
