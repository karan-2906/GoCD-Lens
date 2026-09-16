/**
 * Enforcing a personalized view locally.
 *
 * GoCD is asked to filter by `viewName`, but that is a request, not a
 * guarantee: an older server, a proxy that drops the query string, or a cached
 * response can all hand back the whole instance. These tests pin the local
 * enforcement, which is what keeps the pipeline list, the group sidebar, the
 * filter-chip counts, the badge and the notifications agreeing with each other.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// The worker reaches for these at import time.
globalThis.chrome = {
  runtime: { id: 'x', onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} }, getURL: (p) => p },
  storage: { local: { async get() { return {}; }, async set() {}, async remove() {}, async clear() {} } },
  alarms: { async get() { return null; }, create() {}, onAlarm: { addListener() {} } },
  notifications: { create() {}, clear() {}, onClicked: { addListener() {} } },
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
  tabs: { create() {} },
  permissions: { async contains() { return true; } },
};

const { applyView, isBuiltinView, BUILTIN_VIEWS } = await import('../src/background/service-worker.js');

function pipeline(name, status, { paused = false } = {}) {
  return {
    name,
    pause_info: { paused },
    _embedded: {
      instances: [{ counter: 1, _embedded: { stages: [{ name: 'build', status }] } }],
    },
  };
}

const PAYLOAD = {
  groups: [
    { name: 'personalization', pipelines: ['personalization-api', 'personalization-ui'] },
    { name: 'cda', pipelines: ['cda-build'] },
    { name: 'auth', pipelines: ['auth-service'] },
  ],
  pipelines: [
    pipeline('personalization-api', 'Failed'),
    pipeline('personalization-ui', 'Building'),
    pipeline('cda-build', 'Passed'),
    pipeline('auth-service', 'Passed', { paused: true }),
  ],
};

const names = (result) => result.pipelines.map((p) => p.name);
const groupNames = (result) => result.groups.map((g) => g.name);

test('no view means nothing is filtered', () => {
  const result = applyView(PAYLOAD, null);
  assert.equal(result.pipelines.length, 4);
  assert.equal(result.groups.length, 3);
});

test('a whitelist view keeps only the pipelines it names', () => {
  const result = applyView(PAYLOAD, {
    name: 'Visual Builder',
    type: 'whitelist',
    pipelines: ['personalization-api', 'cda-build'],
  });
  assert.deepEqual(names(result), ['personalization-api', 'cda-build']);
});

test('groups outside the view disappear from the sidebar entirely', () => {
  // A group with nothing left in it is noise in a sidebar of a dozen groups.
  const result = applyView(PAYLOAD, {
    name: 'Visual Builder',
    type: 'whitelist',
    pipelines: ['cda-build'],
  });
  assert.deepEqual(groupNames(result), ['cda']);
});

test('a group inside the view lists only its own pipelines that are in it', () => {
  const result = applyView(PAYLOAD, {
    name: 'Visual Builder',
    type: 'whitelist',
    pipelines: ['personalization-api'],
  });
  assert.deepEqual(groupNames(result), ['personalization']);
  assert.deepEqual(result.groups[0].pipelines, ['personalization-api']);
});

test('a blacklist view keeps everything except what it names', () => {
  const result = applyView(PAYLOAD, {
    name: 'Everything else',
    type: 'blacklist',
    pipelines: ['personalization-api', 'personalization-ui'],
  });
  assert.deepEqual(names(result), ['cda-build', 'auth-service']);
  assert.deepEqual(groupNames(result), ['cda', 'auth']);
});

test('an empty whitelist shows everything, the way GoCD does', () => {
  // A half-built view must not read as "you have no pipelines".
  const result = applyView(PAYLOAD, { name: 'New view', type: 'whitelist', pipelines: [] });
  assert.equal(result.pipelines.length, 4);
});

test('a view that pins a status filters on that too', () => {
  const result = applyView(PAYLOAD, {
    name: 'Broken',
    type: 'whitelist',
    pipelines: ['personalization-api', 'personalization-ui', 'cda-build'],
    state: ['failing'],
  });
  assert.deepEqual(names(result), ['personalization-api']);
});

test('a status-pinned view can ask for running or paused work', () => {
  const base = { name: 'v', type: 'blacklist', pipelines: [] };
  assert.deepEqual(names(applyView(PAYLOAD, { ...base, state: ['building'] })), ['personalization-ui']);
  assert.deepEqual(names(applyView(PAYLOAD, { ...base, state: ['paused'] })), ['auth-service']);
  assert.deepEqual(
    names(applyView(PAYLOAD, { ...base, state: ['failing', 'building'] })),
    ['personalization-api', 'personalization-ui'],
  );
});

test('the filter chips count only what is inside the view', () => {
  // This is the thing that goes wrong invisibly: the Running tab showing work
  // from pipelines the view excludes.
  const inView = applyView(PAYLOAD, {
    name: 'Visual Builder',
    type: 'whitelist',
    pipelines: ['cda-build', 'auth-service'],
  });

  const running = inView.pipelines.filter(
    (p) => p._embedded.instances[0]._embedded.stages[0].status === 'Building',
  );
  assert.deepEqual(running, [], 'personalization-ui is running, but it is not in this view');
  assert.equal(inView.pipelines.length, 2, 'and the All count is the view, not the instance');
});

test('a view naming a pipeline that no longer exists does not break', () => {
  const result = applyView(PAYLOAD, {
    name: 'Stale',
    type: 'whitelist',
    pipelines: ['deleted-long-ago', 'cda-build'],
  });
  assert.deepEqual(names(result), ['cda-build']);
});

test('the original payload is not mutated, so the cache stays trustworthy', () => {
  const before = JSON.stringify(PAYLOAD);
  applyView(PAYLOAD, { name: 'v', type: 'whitelist', pipelines: ['cda-build'] });
  assert.equal(JSON.stringify(PAYLOAD), before);
});

// ------------------------------------------------------- the built-in views

test('the extension\u2019s own views are namespaced so they cannot clash', () => {
  // A GoCD view could legitimately be called "Starred"; these must not collide.
  assert.ok(isBuiltinView('local:starred'));
  assert.ok(isBuiltinView('local:watched'));
  assert.ok(!isBuiltinView('Starred'));
  assert.ok(!isBuiltinView('Visual Builder'));
  assert.ok(!isBuiltinView(null));
});

test('a built-in view is just a whitelist of what you picked', () => {
  // Starring three pipelines out of six thousand should show exactly three.
  const starred = { name: 'local:starred', type: 'whitelist', state: [], pipelines: ['cda-build'] };
  const result = applyView(PAYLOAD, starred);
  assert.deepEqual(names(result), ['cda-build']);
  assert.deepEqual(groupNames(result), ['cda'], 'and only the groups those live in');
});

test('every built-in view names the list it reads from', () => {
  for (const [key, builtin] of Object.entries(BUILTIN_VIEWS)) {
    assert.ok(isBuiltinView(key));
    assert.ok(builtin.label, `${key} needs a label for the dropdown`);
    assert.ok(['favorites', 'watched'].includes(builtin.source));
  }
});
