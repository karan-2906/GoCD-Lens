#!/usr/bin/env node
/**
 * Screenshots for the README.
 *
 * These are the real pages, not mockups: the same HTML, CSS and modules the
 * extension ships, rendered against a fixture GoCD instance and photographed by
 * the Chrome already on this machine. Nothing is added to package.json -- a
 * screenshot tool is not worth a dependency tree in a project that has none.
 *
 * The seam is `chrome.runtime.sendMessage`. Pages never call GoCD; they ask the
 * service worker and get data back, so replacing that one function with a table
 * of canned replies drives every rendering path for real. A card that would be
 * blank in production is blank here too.
 *
 * Two things stop this working over file:// -- ES modules are blocked from an
 * opaque origin, and relative paths must keep resolving -- so the pages are
 * served from a throwaway localhost server rooted at the repo, with the harness
 * injected as a classic inline script. Classic scripts run before deferred
 * module scripts, which is what guarantees the stub exists before the app.
 *
 *   node tools/make-screenshots.mjs [--keep] [--only <name>]
 *
 * SHOT_SERVE=1 holds the server open and prints a URL per shot, for opening in a
 * real browser; SHOT_DEBUG=1 logs every request, which is how a mis-resolved
 * relative path shows itself.
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdir, rm, stat } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS_DIR = join(ROOT, 'docs', 'screenshots');
const STORE_DIR = join(ROOT, 'docs', 'store');
const SITE_DIR = join(ROOT, 'site', 'img');

const CHROME =
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// ------------------------------------------------------------------ fixture

const now = Date.now();
const ago = (minutes) => now - minutes * 60_000;

/**
 * A plausible mid-sized instance: enough groups to need the sidebar, enough
 * states that every colour in the palette appears somewhere, and one pipeline
 * named so the README's fuzzy-search example (`wabp`) actually matches.
 */
const WORLD = [
  ['web', 'web-app-build-prod', [['build', 'Passed'], ['test', 'Passed'], ['deploy-prod', 'Passed']], { minutes: 6 }],
  ['web', 'web-app-build-staging', [['build', 'Passed'], ['test', 'Building'], ['deploy-staging', 'Unknown']], { minutes: 1 }],
  ['web', 'web-marketing-site', [['build', 'Passed'], ['publish', 'Passed']], { minutes: 52 }],
  ['web', 'web-design-system', [['build', 'Failed'], ['test', 'Unknown']], { minutes: 18 }],

  ['checkout', 'checkout-service', [['build', 'Passed'], ['integration', 'Failed'], ['deploy', 'Unknown']], { minutes: 12 }],
  ['checkout', 'checkout-e2e', [['build', 'Passed'], ['e2e', 'Building']], { minutes: 2 }],
  ['checkout', 'checkout-contract-tests', [['build', 'Passed'], ['verify', 'Passed']], { minutes: 96 }],

  ['payments', 'payments-api', [['build', 'Passed'], ['test', 'Passed'], ['deploy-prod', 'Passed']], { minutes: 34 }],
  ['payments', 'payments-ledger', [['build', 'Passed'], ['test', 'Passed'], ['approve', 'Unknown']], { minutes: 41, gate: true }],
  ['payments', 'payments-reconciler', [['build', 'Cancelled']], { minutes: 140 }],

  ['platform', 'platform-auth', [['build', 'Passed'], ['test', 'Passed']], { minutes: 73 }],
  ['platform', 'platform-search-index', [['build', 'Failed']], { minutes: 25 }],
  ['platform', 'platform-notifications', [['build', 'Passed'], ['deploy', 'Passed']], { minutes: 210 }],
  ['platform', 'platform-legacy-sync', [], { minutes: 0, paused: 'Owner left the team; keeping it off until someone adopts it' }],

  ['infrastructure', 'infra-terraform-plan', [['plan', 'Passed'], ['apply', 'Unknown']], { minutes: 15, gate: true }],
  ['infrastructure', 'infra-base-images', [['build', 'Building']], { minutes: 3 }],
  ['infrastructure', 'infra-cost-report', [['collect', 'Passed'], ['publish', 'Passed']], { minutes: 380 }],
];

const GROUP_ORDER = ['web', 'checkout', 'payments', 'platform', 'infrastructure'];

const COUNTERS = {
  'web-app-build-prod': 4127,
  'web-app-build-staging': 8814,
  'checkout-service': 2390,
  'checkout-e2e': 1188,
  'payments-api': 940,
  'payments-ledger': 512,
  'platform-auth': 6602,
  'platform-search-index': 77,
  'web-design-system': 431,
};

const counterFor = (name) => COUNTERS[name] ?? 316;

function pipelineObject([group, name, stages, opts]) {
  const paused = Boolean(opts.paused);
  return {
    name,
    _group: group,
    pause_info: paused
      ? { paused: true, paused_by: 'priya', pause_reason: opts.paused }
      : { paused: false },
    _embedded: {
      instances: stages.length
        ? [
            {
              counter: counterFor(name),
              label: String(counterFor(name)),
              scheduled_at: ago(opts.minutes),
              _embedded: {
                stages: stages.map(([stageName, status], i) => ({
                  name: stageName,
                  status,
                  counter: 1,
                  approval_type: opts.gate && i === stages.length - 1 ? 'manual' : 'success',
                })),
              },
            },
          ]
        : [],
    },
  };
}

const PIPELINES = WORLD.map(pipelineObject);
const GROUPS = GROUP_ORDER.map((name) => ({
  name,
  pipelines: WORLD.filter(([g]) => g === name).map(([, p]) => p),
}));

const CACHE = {
  groups: GROUPS,
  pipelines: PIPELINES,
  etag: '"demo"',
  view: 'Team view',
  fetchedAt: ago(0.2),
};

const VIEWS = [
  { name: 'Team view', pipelines: WORLD.map(([, p]) => p) },
  { name: 'Release train', pipelines: ['web-app-build-prod', 'payments-api', 'platform-auth'] },
  { name: 'Everything I own', pipelines: WORLD.map(([, p]) => p) },
];

const FAVORITES = ['checkout-service', 'web-app-build-prod', 'payments-api'];
const WATCHED = ['checkout-service', 'web-app-build-staging'];

const STATE = {
  connection: {
    serverUrl: 'https://gocd.internal.example.com/go',
    authMode: 'session',
    hasSecret: false,
    secretHint: null,
  },
  hasPermission: true,
  settings: {
    pollSeconds: 10,
    notifyWhenClosed: true,
    backgroundMinutes: 5,
    activeView: 'Team view',
    notifications: true,
    notifyStarred: true,
    badgeSource: 'watched',
    sound: true,
    theme: 'light',
    density: 'comfortable',
  },
  favorites: FAVORITES,
  watched: WATCHED,
  cache: CACHE,
  recent: ['checkout-service', 'web-app-build-prod'],
  expandedGroups: GROUP_ORDER,
  views: VIEWS,
};

/** One pipeline's run history, for the detail screen. */
function historyRuns(pipeline) {
  const base = counterFor(pipeline);
  const shapes = [
    { stages: [['build', 'Passed'], ['integration', 'Failed'], ['deploy', 'Unknown']], minutes: 12 },
    { stages: [['build', 'Passed'], ['integration', 'Passed'], ['deploy', 'Passed']], minutes: 88 },
    { stages: [['build', 'Passed'], ['integration', 'Passed'], ['deploy', 'Passed']], minutes: 171 },
    { stages: [['build', 'Passed'], ['integration', 'Cancelled'], ['deploy', 'Unknown']], minutes: 254 },
    { stages: [['build', 'Failed'], ['integration', 'Unknown'], ['deploy', 'Unknown']], minutes: 330 },
  ];
  const messages = [
    ['a4f19c2d3b7e5081', 'Reject expired discount codes at capture time', 'Priya Nair'],
    ['b81d0e7a44c9f312', 'Bump checkout-sdk to 4.2.0', 'Tom Alvarez'],
    ['c02e5518f9a7d446', 'Retry the payment gateway once on a 502', 'Priya Nair'],
    ['d7391aa0c5e2b688', 'Log the correlation id on every capture attempt', 'Sam Oduya'],
    ['e5c48b2213f0a970', 'Split the integration stage into two jobs', 'Tom Alvarez'],
  ];
  return shapes.map((shape, i) => ({
    counter: base - i,
    label: String(base - i),
    scheduled_date: ago(shape.minutes),
    stages: shape.stages.map(([name, status], si) => ({
      name,
      status,
      result: status,
      counter: 1,
      approval_type: si === 2 ? 'manual' : 'success',
      jobs:
        name === 'integration'
          ? [
              { name: 'api-tests', state: 'Completed', result: status === 'Failed' ? 'Failed' : status },
              { name: 'browser-tests-1', state: 'Completed', result: status === 'Failed' ? 'Failed' : status },
              { name: 'browser-tests-2', state: 'Completed', result: status === 'Unknown' ? 'Unknown' : 'Passed' },
              { name: 'browser-tests-3', state: 'Completed', result: status === 'Unknown' ? 'Unknown' : 'Passed' },
            ]
          : [{ name: name === 'build' ? 'compile' : 'ship', state: 'Completed', result: status }],
    })),
    build_cause: {
      trigger_message: 'modified by Priya Nair',
      material_revisions: [
        {
          material: {
            type: 'Git',
            description: `URL: https://github.com/example-org/${pipeline}.git, Branch: main`,
          },
          modifications: [
            {
              revision: messages[i][0],
              comment: messages[i][1],
              user_name: messages[i][2],
              modified_time: ago(shape.minutes + 4),
            },
          ],
        },
        {
          material: { type: 'Pipeline', description: 'platform-auth' },
          modifications: [{ revision: 'platform-auth/6602/build/1', modified_time: ago(shape.minutes + 30) }],
        },
      ],
    },
  }));
}

const LOG = [
  'go|00:00:00.004 Start to prepare checkout-service/2390/integration/1/api-tests on agent-linux-07',
  'go|00:00:00.121 Start to update materials',
  'ex|00:00:01.884 Cloning into /var/lib/go-agent/pipelines/checkout-service...',
  'ex|00:00:04.210 HEAD is now at a4f19c2 Reject expired discount codes at capture time',
  'go|00:00:04.288 Start to build',
  'ex|00:00:04.901 > npm ci --prefer-offline',
  'ex|00:00:21.336 added 1284 packages in 16s',
  'ex|00:00:21.400 > npm run test:integration',
  'ex|00:00:23.019 ',
  'ex|00:00:23.020   checkout / capture',
  'ex|00:00:24.551     ✓ captures a valid card (412ms)',
  'ex|00:00:25.118     ✓ declines an expired card (287ms)',
  'ex|00:00:26.774     ✓ retries once on a gateway 502 (1.2s)',
  'ex|00:00:27.005 ',
  'ex|00:00:27.006   checkout / discounts',
  'ex|00:00:28.442     ✓ applies a percentage discount (338ms)',
  'ex|00:00:30.910     1) rejects an expired discount code',
  'ex|00:00:31.002 ',
  'ex|00:00:31.118   4 passing (8s)',
  'ex|00:00:31.119   1 failing',
  'ex|00:00:31.201 ',
  'ex|00:00:31.202   1) checkout / discounts rejects an expired discount code:',
  'ex|00:00:31.203      AssertionError: expected 200 to equal 422',
  'ex|00:00:31.204       + expected - actual',
  'ex|00:00:31.205       -200',
  'ex|00:00:31.206       +422',
  'ex|00:00:31.290       at Context.<anonymous> (test/discounts.spec.js:118:31)',
  'ex|00:00:31.404       at processTicksAndRejections (node:internal/process/task_queues:95:5)',
  'ex|00:00:31.560 ',
  'ex|00:00:31.771 WARNING: 3 deprecated APIs were called during this run',
  'ex|00:00:32.004 npm ERR! Lifecycle script `test:integration` failed with error 1',
  'go|00:00:32.118 Uploading artifacts from /reports/junit.xml',
  'go|00:00:32.660 [go] Job completed with result Failed',
].join('\n');

const ARTIFACTS = [
  { name: 'reports', type: 'folder', files: [
    { name: 'junit.xml', type: 'file', size: 48213, url: '#' },
    { name: 'coverage.html', type: 'file', size: 291044, url: '#' },
  ] },
  { name: 'screenshots', type: 'folder', files: [
    { name: 'discounts-failure.png', type: 'file', size: 184220, url: '#' },
  ] },
  { name: 'cruise-output', type: 'folder', files: [
    { name: 'console.log', type: 'file', size: 19844, url: '#' },
  ] },
];

/** Replies keyed by message type, exactly as the worker would answer. */
const REPLIES = {
  getState: STATE,
  refresh: CACHE,
  views: VIEWS,
  history: { runs: historyRuns('checkout-service'), next: null },
  instance: { counter: 2390, label: '2390', stages: historyRuns('checkout-service')[0].stages },
  consoleLog: { text: LOG, complete: true, nextLine: 36 },
  artifacts: ARTIFACTS,
  webUrl: 'https://gocd.internal.example.com/go/pipelines',
  notificationStatus: { level: 'granted', canNotify: true },
  toggleFavorite: FAVORITES,
  toggleWatched: WATCHED,
  setExpandedGroups: GROUP_ORDER,
  updateSettings: STATE.settings,
  diagnose: {
    probes: [
      { id: 'permission', label: 'Browser permission for this origin', ok: true, summary: 'granted', ms: 0 },
      { id: 'reachable', label: 'Server reachable', ok: true, summary: 'answered in 84ms', ms: 84 },
      { id: 'version', label: 'GoCD API', ok: true, summary: 'GoCD 23.5.0', ms: 96 },
      { id: 'identity', label: 'Who the server thinks you are', ok: true, summary: 'signed in as priya', ms: 71 },
      { id: 'dashboard', label: 'Dashboard payload', ok: true, summary: '17 pipelines visible', ms: 212 },
      { id: 'webui', label: 'GoCD web UI', ok: false, summary: 'timed out after 10s', ms: 10000 },
    ],
    verdict: 'The API is answering normally and the web UI is not. This is the situation GoCD Lens exists for.',
  },
};

/** The theme is a setting, so a dark shot is a different reply, not a CSS poke. */
function repliesFor(shot) {
  if (!shot.theme) return REPLIES;
  return {
    ...REPLIES,
    getState: { ...STATE, settings: { ...STATE.settings, theme: shot.theme } },
  };
}

// ------------------------------------------------------------------ harness

/**
 * Replaces the one function that reaches the service worker, plus the few other
 * chrome APIs a page touches. Everything above this line is data; everything
 * below the app is untouched product code.
 */
function harness({ replies, driver = '' }) {
  return `
(() => {
  const REPLIES = ${JSON.stringify(replies)};
  const store = {};
  globalThis.chrome = {
    runtime: {
      id: 'demo',
      // Extension URLs resolve from the package root, not from the page. Getting
      // this wrong 404s the icon sprite, and DOMParser turns the 404 body into an
      // XML error document that lands in the page instead of the icons.
      getURL: (p) => new URL(String(p).replace(/^\\/+/, ''), location.origin + '/').href,
      openOptionsPage() {},
      sendMessage: async ({ type }) => {
        if (!(type in REPLIES)) return { ok: true, data: null };
        return { ok: true, data: REPLIES[type] };
      },
      onMessage: { addListener() {}, removeListener() {} },
      lastError: null,
    },
    storage: {
      local: {
        async get(keys) {
          if (keys == null) return { ...store };
          const wanted = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
          const out = {};
          for (const k of wanted) if (k in store) out[k] = store[k];
          return out;
        },
        async set(items) { Object.assign(store, items); },
        async remove(keys) { for (const k of [].concat(keys)) delete store[k]; },
        async clear() { for (const k of Object.keys(store)) delete store[k]; },
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
    permissions: { request: async () => true, contains: async () => true },
    tabs: { create() {} },
  };

  // Screenshots should not catch a half-painted frame, and the caret blinking
  // in a search box reads as a rendering artefact rather than a feature.
  const style = document.createElement('style');
  style.textContent = '*{caret-color:transparent!important}';
  document.head.append(style);

  const ready = () => {
    ${driver}
  };
  if (document.readyState === 'complete') setTimeout(ready, 350);
  else addEventListener('load', () => setTimeout(ready, 350));
})();
`;
}

/** Waits for the first match whose text contains `text`. */
const waitForText = (selector, text, body) => `
  (function attempt(tries) {
    const node = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((n) => n.textContent.includes(${JSON.stringify(text)}));
    if (!node) { if (tries < 60) setTimeout(() => attempt(tries + 1), 100); return; }
    (function (el) { ${body} })(node);
  })(0);
`;

/** Waits for a selector, then runs `fn` -- the app paints asynchronously. */
const waitFor = (selector, body) => `
  (function attempt(tries) {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) { if (tries < 60) setTimeout(() => attempt(tries + 1), 100); return; }
    (function (el) { ${body} })(node);
  })(0);
`;

/**
 * The promo tiles the Chrome Web Store asks for, at the sizes it demands. Built
 * from the extension's own tokens rather than a design tool, so the tile cannot
 * drift away from what the product looks like.
 */
function promoTile({ width, height, shot }) {
  const wide = width > 800;
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #262c36;
    --text: #e6edf3; --muted: #8b949e;
    --accent: #4d8bf5; --pass: #3fb950; --fail: #f85149; --build: #58a6ff;
    --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: ${width}px; height: ${height}px; overflow: hidden;
    background: radial-gradient(120% 140% at 0% 0%, #1b2330 0%, var(--bg) 55%);
    color: var(--text); font-family: var(--font);
    display: flex; align-items: center; gap: ${wide ? 56 : 0}px;
    padding: ${wide ? '0 72px' : '0'};
    ${wide ? '' : 'flex-direction: column; justify-content: center; text-align: center;'}
  }
  .words { flex: ${wide ? '0 0 460px' : 'none'}; }
  .brand { display: flex; align-items: center; gap: 14px; ${wide ? '' : 'justify-content: center;'} }
  .brand img { width: ${wide ? 56 : 44}px; height: ${wide ? 56 : 44}px; border-radius: 12px; }
  .brand h1 { font-size: ${wide ? 44 : 32}px; letter-spacing: -0.02em; font-weight: 700; }
  .tag {
    margin-top: ${wide ? 20 : 14}px; font-size: ${wide ? 21 : 15}px; line-height: 1.45;
    color: var(--muted); max-width: ${wide ? 460 : 340}px; ${wide ? '' : 'margin-left: auto; margin-right: auto;'}
  }
  .tag b { color: var(--text); font-weight: 600; }
  .strip { display: flex; gap: 6px; margin-top: ${wide ? 28 : 20}px; ${wide ? '' : 'justify-content: center;'} }
  .seg { height: 6px; width: ${wide ? 64 : 44}px; border-radius: 3px; }
  .shot {
    flex: 1; height: ${height - 96}px; border-radius: 14px; overflow: hidden;
    border: 1px solid var(--border); box-shadow: 0 24px 60px rgba(0,0,0,0.45);
  }
  .shot img { width: 1360px; margin: -1px 0 0 -1px; display: block; }
</style></head>
<body>
  <div class="words">
    <div class="brand">
      <img src="../../icons/icon128.png" alt="">
      <h1>GoCD Lens</h1>
    </div>
    <p class="tag">Your GoCD pipelines, straight from the API &mdash; <b>still there when the GoCD web UI isn't</b>.</p>
    <div class="strip">
      <div class="seg" style="background: var(--pass)"></div>
      <div class="seg" style="background: var(--pass)"></div>
      <div class="seg" style="background: var(--fail)"></div>
      <div class="seg" style="background: var(--build)"></div>
    </div>
  </div>
  ${shot ? `<div class="shot"><img src="/docs/screenshots/${shot}" alt=""></div>` : ''}
</body></html>`;
}

/** Store assets: exact pixel sizes, 1x, because the store rejects anything else. */
const STORE = [
  { name: 'store-dashboard', page: 'src/dashboard/dashboard.html', width: 1280, height: 800 },
  {
    name: 'store-pipeline',
    page: 'src/dashboard/dashboard.html',
    width: 1280,
    height: 800,
    driver: waitFor('.card-p', 'el.click();'),
  },
  {
    name: 'store-console',
    page: 'src/dashboard/dashboard.html',
    width: 1280,
    height: 800,
    driver: waitFor('.card-p', `
      el.click();
      ${waitForText('.job-row', 'api-tests', "el.querySelector('.job-open').click();")}
    `),
  },
  { name: 'store-dark', page: 'src/dashboard/dashboard.html', width: 1280, height: 800, theme: 'dark' },
  { name: 'store-settings', page: 'src/setup/setup.html', width: 1280, height: 800 },
  { name: 'promo-small', promo: true, width: 440, height: 280 },
  { name: 'promo-marquee', promo: true, width: 1400, height: 560, shot: 'dashboard-dark.png' },
];

/**
 * What the marketing site serves. Smaller than the README's shots on purpose --
 * a landing page that ships two megabytes of PNG is a landing page nobody waits
 * for -- and it includes the 1200x630 card that link previews and search results
 * use.
 */
const SITE = [
  { name: 'hero', page: 'src/dashboard/dashboard.html', width: 1280, height: 800, scale: 2 },
  { name: 'dark', page: 'src/dashboard/dashboard.html', width: 1280, height: 800, theme: 'dark' },
  {
    name: 'pipeline',
    page: 'src/dashboard/dashboard.html',
    width: 1280,
    height: 800,
    driver: waitFor('.card-p', 'el.click();'),
  },
  {
    name: 'console',
    page: 'src/dashboard/dashboard.html',
    width: 1280,
    height: 800,
    driver: waitFor('.card-p', `
      el.click();
      ${waitForText('.job-row', 'api-tests', "el.querySelector('.job-open').click();")}
    `),
  },
  {
    name: 'search',
    page: 'src/dashboard/dashboard.html',
    width: 1280,
    height: 800,
    driver: waitFor('#search', `
      el.value = 'wabp';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    `),
  },
  { name: 'popup', page: 'src/popup/popup.html', width: 400, height: 600, scale: 2 },
  { name: 'og', promo: true, width: 1200, height: 630, shot: 'dashboard-dark.png' },
];

const SHOTS = [
  {
    name: 'dashboard',
    page: 'src/dashboard/dashboard.html',
    width: 1440,
    height: 900,
    caption: 'The pipeline list',
  },
  {
    name: 'dashboard-dark',
    page: 'src/dashboard/dashboard.html',
    width: 1440,
    height: 900,
    theme: 'dark',
    caption: 'The same list in dark mode',
  },
  {
    name: 'search',
    page: 'src/dashboard/dashboard.html',
    width: 1440,
    height: 900,
    caption: 'Fuzzy search: four letters find web-app-build-prod',
    driver: waitFor('#search', `
      el.value = 'wabp';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    `),
  },
  {
    name: 'pipeline',
    page: 'src/dashboard/dashboard.html',
    width: 1440,
    height: 900,
    caption: 'One pipeline: history, stages, jobs and what it was built from',
    driver: waitFor('.card-p', 'el.click();'),
  },
  {
    name: 'console',
    page: 'src/dashboard/dashboard.html',
    width: 1440,
    height: 900,
    caption: 'A job\'s console log, with severity colouring and the artifact tree',
    // Three steps in: open the pipeline, then the failed job's log. Each waits
    // for the screen before it, because every one of them paints from a reply.
    driver: waitFor('.card-p', `
      el.click();
      ${waitForText('.job-row', 'api-tests', "el.querySelector('.job-open').click();")}
    `),
  },
  {
    name: 'popup',
    page: 'src/popup/popup.html',
    width: 400,
    height: 600,
    caption: 'The toolbar popup',
  },
  {
    name: 'settings',
    page: 'src/setup/setup.html',
    width: 1100,
    height: 950,
    caption: 'Settings',
  },
];

// ------------------------------------------------------------------- server

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.json': 'application/json',
};

async function serve(shots) {
  const byName = new Map(shots.map((s) => [s.name, s]));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    // The harness page is served from the real page's own path, with the shot
    // named in the query. Serving it from /shot/<name> instead would re-root
    // every relative URL in the file -- ../common/base.css stops resolving and
    // the screenshot comes out as unstyled HTML.
    const shotName = url.searchParams.get('shot');
    const promoName = url.searchParams.get('promo');

    if (process.env.SHOT_DEBUG) console.error('REQ', req.url);
    try {
      // A promo tile has no file on disk; it is composed from the tokens here.
      if (promoName) {
        const tile = byName.get(promoName);
        if (!tile) throw new Error(`no promo ${promoName}`);
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(promoTile(tile));
        return;
      }

      if (shotName) {
        const shot = byName.get(shotName);
        if (!shot) throw new Error(`no shot ${shotName}`);
        const html = await readFile(join(ROOT, shot.page), 'utf8');
        // Injected ahead of the page's own <script type="module">, which is
        // deferred -- so the stub is in place before a line of the app runs.
        const injected = html.replace(
          /<script type="module"/,
          `<script>${harness({ replies: repliesFor(shot), driver: shot.driver })}</script>\n    <script type="module"`,
        );
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(injected);
        return;
      }

      const file = join(ROOT, decodeURIComponent(url.pathname));
      if (!file.startsWith(ROOT)) throw new Error('outside root');
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch (err) {
      if (process.env.SHOT_DEBUG) console.error('404', req.url, err.message);
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

// ------------------------------------------------------------------- chrome

function capture({ url, out, width, height, profile, scale = 2 }) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    `--force-device-scale-factor=${scale}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    '--virtual-time-budget=6000',
    `--screenshot=${out}`,
    url,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);

    // The page polls on a timer, so virtual time never runs dry and Chrome will
    // sit there indefinitely after writing the PNG. It also writes more than
    // once -- an early capture of the undriven page, then the real one -- so the
    // file appearing is not the signal. Waiting for its size to settle is, and
    // the floor keeps the first write from being mistaken for the last.
    let last = -1;
    let settled = 0;
    const started = Date.now();
    const poll = setInterval(async () => {
      try {
        const { size } = await stat(out);
        settled = size === last ? settled + 1 : 0;
        last = size;
        if (size > 0 && settled >= 4 && Date.now() - started > 12_000) child.kill('SIGKILL');
      } catch {
        /* not written yet */
      }
    }, 400);
    const deadline = setTimeout(() => child.kill('SIGKILL'), 45_000);
    child.on('exit', async () => {
      clearTimeout(deadline);
      clearInterval(poll);
      try {
        await stat(out);
        resolve();
      } catch {
        reject(new Error(`no screenshot written\n${stderr.slice(-800)}`));
      }
    });
  });
}

// --------------------------------------------------------------------- main

const arg = (flag) =>
  process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : null;

// The store wants exact pixel sizes at 1x and rejects anything else; the README
// wants 2x, because it is read on retina screens.
const store = process.argv.includes('--store');
const site = process.argv.includes('--site');
const all = store ? STORE : site ? SITE : SHOTS;
const dir = store ? STORE_DIR : site ? SITE_DIR : SHOTS_DIR;
const scale = store ? 1 : site ? 1 : 2;

const only = arg('--only');
const shots = only ? all.filter((s) => s.name === only) : all;
if (shots.length === 0) {
  console.error(only ? `No shot named ${only}.` : 'Nothing to do.');
  process.exit(1);
}

await mkdir(dir, { recursive: true });
const profile = join(tmpdir(), `gocd-lens-shots-${process.pid}`);
const { server, port } = await serve([...SHOTS, ...STORE, ...SITE]);

const urlFor = (shot) =>
  shot.promo
    ? `http://127.0.0.1:${port}/docs/store/promo.html?promo=${shot.name}`
    : `http://127.0.0.1:${port}/${shot.page}?shot=${shot.name}`;

// Opening one of these in a real browser is the only way to see what the camera
// sees while a driver is being written.
if (process.env.SHOT_SERVE) {
  for (const shot of [...SHOTS, ...STORE, ...SITE]) {
    console.log(`  ${shot.name.padEnd(18)} ${urlFor(shot)}`);
  }
  await new Promise(() => {});
}

try {
  for (const shot of shots) {
    await capture({
      url: urlFor(shot),
      out: join(dir, `${shot.name}.png`),
      width: shot.width,
      height: shot.height,
      profile,
      scale: shot.scale ?? scale,
    });
    console.log(`  ${shot.name}.png  ${shot.width}x${shot.height}`);
  }
} finally {
  server.close();
  if (!process.argv.includes('--keep')) await rm(profile, { recursive: true, force: true });
}

const where = store ? 'docs/store' : site ? 'site/img' : 'docs/screenshots';
console.log(`\nWrote ${shots.length} image(s) to ${where}/`);
