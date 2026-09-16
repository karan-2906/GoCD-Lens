/**
 * The only place in this extension that holds a credential or opens a socket.
 *
 * Pages (dashboard, popup, setup) never see the token and never call GoCD
 * directly -- they post a message here, this worker makes the request, and only
 * the resulting data goes back. A bug in a rendering path therefore cannot leak
 * the credential, and there are no content scripts at all, so no web page can
 * reach any of this.
 */

import {
  getConnection,
  setConnection,
  clearConnection,
  redactConnection,
  getSettings,
  setSettings,
  getFavorites,
  toggleFavorite,
  getWatched,
  toggleWatched,
  getCache,
  setCache,
  getSeenStatus,
  setSeenStatus,
  getRecent,
  pushRecent,
  getExpandedGroups,
  setExpandedGroups,
  getViewDefinitions,
  setViewDefinitions,
  wipeEverything,
  backgroundPeriodMinutes,
} from '../lib/store.js';
import { GoCdClient, GoCdError, originPattern } from '../lib/gocd.js';
import { pipelineStatus, stageStatus, isActive } from '../lib/status.js';

const POLL_ALARM = 'gocd-lens-poll';

// ---------------------------------------------------------------- lifecycle

chrome.runtime.onInstalled.addListener(async (details) => {
  await ensureAlarm();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/setup/setup.html?welcome=1') });
  }
});

chrome.runtime.onStartup.addListener(ensureAlarm);

async function ensureAlarm() {
  // chrome.alarms floors at one minute. An open dashboard refreshes itself on
  // its own faster cadence, so this is only the badge-and-notify heartbeat for
  // when nothing is open.
  const settings = await getSettings();
  const minutes = backgroundPeriodMinutes(settings);
  const existing = await chrome.alarms.get(POLL_ALARM);

  if (minutes <= 0) {
    if (existing) await chrome.alarms.clear(POLL_ALARM);
    return;
  }
  if (existing && existing.periodInMinutes === minutes) return;
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: minutes, delayInMinutes: 0.2 });
}

/**
 * Consecutive background polls that found nothing moving. A GoCD instance is
 * quiet most nights and weekends, and asking it the same question every minute
 * through all of them is load nobody benefits from.
 */
let quietPolls = 0;

function shouldSkipBackgroundPoll(cached) {
  if (quietPolls < 5) return false;
  // Back off to roughly one poll in four once things have been still for a
  // while. Any change at all resets this immediately.
  return quietPolls % 4 !== 0;
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== POLL_ALARM) return;
  try {
    const cached = await getCache();
    const busy = (cached?.pipelines || []).some((p) => isActive(pipelineStatus(p)));
    if (busy) quietPolls = 0;
    else if (shouldSkipBackgroundPoll(cached)) {
      quietPolls += 1;
      return;
    }

    const before = cached?.etag;
    const after = await refreshDashboard({ background: true });
    quietPolls = after?.etag && after.etag === before ? quietPolls + 1 : 0;
  } catch {
    // A background poll failing is normal (VPN down, laptop asleep). The cached
    // dashboard stays browsable and the badge says the data is stale.
    await setBadge({ offline: true });
  }
});

chrome.notifications.onClicked.addListener((notificationId) => {
  const pipeline = notificationId.startsWith('pipeline:') ? notificationId.slice(9) : null;
  const url = chrome.runtime.getURL(
    `src/dashboard/dashboard.html${pipeline ? `?pipeline=${encodeURIComponent(pipeline)}` : ''}`,
  );
  chrome.tabs.create({ url });
  chrome.notifications.clear(notificationId);
});

// ------------------------------------------------------------------ helpers

async function client() {
  const conn = await getConnection();
  if (!conn) throw new GoCdError('No GoCD server configured yet.', { kind: 'config' });
  return new GoCdClient(conn);
}

/** Has the user granted this extension access to the configured host? */
async function hasHostPermission(serverUrl) {
  try {
    return await chrome.permissions.contains({ origins: [originPattern(serverUrl)] });
  } catch {
    return false;
  }
}

// --------------------------------------------------------------- dashboard

let inFlight = null;

/**
 * Fetch the dashboard, fall back to the cache, and keep the toolbar badge and
 * notifications in step. Concurrent callers share one request.
 */
async function refreshDashboard({ force = false, view = undefined, background = false } = {}) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const conn = await getConnection();
    if (!conn) return { configured: false };

    const settings = await getSettings();
    // Omitting `view` means "whatever is selected"; passing null means "all
    // pipelines", which is a choice the user can make and must be able to undo.
    const changingView = view !== undefined;
    const activeView = changingView ? view : (settings.activeView ?? null);
    if (changingView && view !== settings.activeView) {
      await setSettings({ activeView: view });
    }

    const cached = await getCache();
    const api = new GoCdClient(conn);
    // A cache built for another view must not answer for this one, so its ETag
    // is withheld and the server sends the real payload.
    const sameView = (cached?.view ?? null) === activeView;

    // Several dashboard tabs, a popup and the background alarm all poll on their
    // own timers. Without this they would each hit GoCD separately, so a user
    // with three tabs open would triple the load for no extra information.
    // Anything asked for inside one poll interval is served from the cache.
    if (!force && sameView && cached) {
      const age = Date.now() - (cached.fetchedAt || 0);
      const window = Math.max(5_000, (settings.pollSeconds || 30) * 900);
      if (age < window) {
        // Cheap, and it makes the badge self-healing after a worker restart.
        await setBadge({ pipelines: cached.pipelines });
        return cached;
      }
    }

    const etag = force || !sameView ? null : cached?.etag;

    const serverView = isBuiltinView(activeView) ? null : activeView;

    let result;
    try {
      result = await api.dashboard({ etag, view: serverView });
    } catch (err) {
      // Observed in the wild: GoCD's view lookup broke while the pipelines
      // themselves were fine, so `?viewName=...` failed and the web UI went
      // down with it -- yet a plain dashboard request still answered correctly.
      //
      // Ask again without the filter and enforce the view from the definition
      // already on disk. Only worth doing when we have that definition, because
      // otherwise the unfiltered payload is both wrong and expensive.
      result = await retryUnfiltered(api, serverView, err);
      if (!result) {
        await setBadge({ offline: true });
        if (cached) return { ...cached, stale: true, error: describe(err) };
        throw err;
      }
    }

    if (result.notModified && cached && sameView) {
      const payload = { ...cached, etag: result.etag || cached.etag, fetchedAt: Date.now() };
      await setCache(payload);
      await setBadge({ pipelines: payload.pipelines });
      return payload;
    }

    const filtered = applyView(
      { groups: result.groups, pipelines: result.pipelines },
      activeView ? await viewDefinition(api, activeView) : null,
    );

    // An empty built-in view means the user has starred or watched nothing yet,
    // which should read as "nothing here yet", not as an empty server.
    if (isBuiltinView(activeView) && filtered.pipelines.length === 0) {
      filtered.builtinEmpty = true;
    }

    const payload = {
      groups: filtered.groups,
      pipelines: filtered.pipelines,
      etag: result.etag,
      view: activeView,
      fetchedAt: Date.now(),
    };
    await setCache(payload);
    await announceChanges(payload.pipelines, {
      // Silent on a first load with nothing to compare against, on a view
      // change, and on a background poll when being interrupted with nothing
      // open was not asked for. The badge still updates in every case.
      silent: (!background && !cached) || !sameView || (background && !settings.notifyWhenClosed),
    });
    await setBadge({ pipelines: payload.pipelines });
    return payload;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

function describe(err) {
  return err instanceof GoCdError ? err.message : String(err?.message || err);
}

// --------------------------------------------------------- view filtering

/**
 * Views the extension provides itself, on top of whatever the user built in
 * GoCD. They are prefixed so they can never collide with a real view name.
 *
 * GoCD cannot filter by these -- it knows nothing about which pipelines you
 * starred -- so the server sends everything and the filtering happens here.
 * That is a heavier payload than a GoCD view, which is the honest trade for
 * being able to watch a handful of pipelines from across the whole instance.
 */
export const BUILTIN_VIEWS = {
  'local:starred': { label: 'Starred', source: 'favorites' },
  'local:watched': { label: 'Watching', source: 'watched' },
};

export function isBuiltinView(name) {
  return typeof name === 'string' && name.startsWith('local:');
}

async function builtinDefinition(name) {
  const builtin = BUILTIN_VIEWS[name];
  if (!builtin) return null;
  const pipelines = builtin.source === 'watched' ? await getWatched() : await getFavorites();
  return { name, type: 'whitelist', state: [], pipelines };
}


/**
 * Apply a personalized view to a dashboard payload.
 *
 * GoCD is asked to do this server-side via `viewName`, but that is a request,
 * not a guarantee -- an older server, a proxy that drops query strings, or a
 * cached response can all hand back the unfiltered set. Enforcing the view here
 * as well means the pipeline list, the group counts, the filter chips, the
 * toolbar badge and the notifications cannot disagree about what "this view"
 * contains.
 */
export function applyView({ groups, pipelines }, definition) {
  if (!definition) return { groups, pipelines };

  const listed = new Set(definition.pipelines || []);
  const blacklist = definition.type === 'blacklist';
  // A view with an empty whitelist means "nothing chosen yet", which GoCD shows
  // as everything rather than as an empty dashboard.
  const byName =
    !blacklist && listed.size === 0 ? () => true : (name) => (blacklist ? !listed.has(name) : listed.has(name));

  // Views can also pin a status, the way the web dashboard's tabs do.
  const wanted = new Set((definition.state || []).map((s) => String(s).toLowerCase()));
  const byState = (pipeline) => {
    if (wanted.size === 0) return true;
    const status = pipelineStatus(pipeline);
    if (wanted.has('failing') && status === 'Failed') return true;
    if (wanted.has('building') && status === 'Building') return true;
    if (wanted.has('paused') && pipeline.pause_info?.paused) return true;
    return false;
  };

  const keptPipelines = pipelines.filter((p) => byName(p.name) && byState(p));
  const kept = new Set(keptPipelines.map((p) => p.name));
  const keptGroups = groups
    .map((group) => ({ ...group, pipelines: (group.pipelines || []).filter((n) => kept.has(n)) }))
    .filter((group) => group.pipelines.length > 0);

  return { groups: keptGroups, pipelines: keptPipelines };
}

/**
 * Second attempt at the dashboard, without the server-side view filter.
 *
 * Returns null when it is not worth trying, or when it fails too -- the caller
 * then falls back to the cache as it always did.
 */
async function retryUnfiltered(api, serverView, firstError) {
  if (!serverView || firstError?.kind === 'network' || firstError?.kind === 'auth') return null;

  const definitions = await getViewDefinitions();
  if (!definitions.some((view) => view.name === serverView)) return null;

  try {
    // No ETag: the unfiltered dashboard is a different resource to the filtered
    // one, and its tag would be meaningless here.
    return await api.dashboard({ etag: null, view: null });
  } catch {
    return null;
  }
}

/**
 * The definition of the active view, from cache, fetched once if we have not
 * seen it. A failure here must not break the refresh -- it only means the view
 * is enforced by the server alone, which is the old behaviour.
 */
async function viewDefinition(api, name) {
  if (isBuiltinView(name)) return builtinDefinition(name);
  const cached = await getViewDefinitions();
  const found = cached.find((v) => v.name === name);
  if (found) return found;
  try {
    const { filters } = await api.views();
    await setViewDefinitions(filters);
    return filters.find((v) => v.name === name) || null;
  } catch {
    return null;
  }
}

// --------------------------------------------------------- badge + notify

/**
 * The toolbar badge.
 *
 * It describes the pipelines *you* signed up for -- the ones you are watching,
 * or failing that the ones you starred -- rather than whatever view happens to
 * be open, so the number does not change meaning as you browse. A red count is
 * failures; with nothing failing it turns blue and counts what is running.
 *
 * It can only count pipelines present in the last payload, and a GoCD view may
 * exclude some of what you watch. Rather than quietly undercount, the tooltip
 * says how many it could not see.
 */
async function setBadge({ pipelines = null, offline = false } = {}) {
  if (offline) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#B45309' });
    await chrome.action.setTitle({ title: 'GoCD Lens - showing cached data, cannot reach GoCD' });
    return;
  }
  if (!pipelines) return;

  const settings = await getSettings();
  const [watched, favorites] = await Promise.all([getWatched(), getFavorites()]);

  let label = null;
  let names = null;
  switch (settings.badgeSource) {
    case 'watched':
      label = 'watching';
      names = new Set(watched);
      break;
    case 'starred':
      label = 'starred';
      names = new Set(favorites);
      break;
    // 'view', and anything an older profile might still hold.
    default:
      break;
  }

  // An explicit choice with an empty list should say so rather than silently
  // widening to every pipeline on the server.
  if (names && names.size === 0) {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({
      title: `GoCD Lens - nothing ${label} yet. Press the ${label === 'watching' ? 'bell' : 'star'} on a pipeline.`,
    });
    return;
  }

  const counted = names ? pipelines.filter((p) => names.has(p.name)) : pipelines;
  const unseen = names ? names.size - counted.length : 0;

  const failing = counted.filter((p) => pipelineStatus(p) === 'Failed').length;
  // A run parked at a manual approval gate rolls up to Passed, not Building,
  // so it correctly does not appear here.
  const running = counted.filter((p) => pipelineStatus(p) === 'Building').length;

  // Running wins over failing.
  //
  // The badge is the one thing on screen all day, so it should answer "is
  // anything happening right now" -- a number that moves while work is in
  // flight and settles when it is done. A failure is a state that persists for
  // hours and is already plain in the list, the popup and the notification; a
  // badge stuck on it all week says nothing new and trains you to ignore it.
  // With nothing running, the failure count is the next most useful thing.
  if (running > 0) {
    await chrome.action.setBadgeText({ text: String(running) });
    await chrome.action.setBadgeBackgroundColor({ color: '#2563EB' });
  } else if (failing > 0) {
    await chrome.action.setBadgeText({ text: String(failing) });
    await chrome.action.setBadgeBackgroundColor({ color: '#DC2626' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }

  await chrome.action.setTitle({ title: badgeTooltip({ failing, running, counted, label, unseen, settings }) });
}

function badgeTooltip({ failing, running, counted, label, unseen, settings }) {
  const of = label
    ? `of ${counted.length + unseen} ${label}`
    : settings.activeView
      ? `in ${BUILTIN_VIEWS[settings.activeView]?.label ?? settings.activeView}`
      : 'across every pipeline';

  const parts = [];
  if (running) parts.push(`${running} running`);
  if (failing) parts.push(`${failing} failing`);

  const summary = parts.length ? `${parts.join(', ')} ${of}` : `nothing failing or running ${of}`;
  const caveat = unseen > 0 ? ` (${unseen} not in the current view)` : '';
  return `GoCD Lens - ${summary}${caveat}`;
}

/**
 * Notify on the transition, not the state: a pipeline that has been red all
 * week should not re-notify every minute.
 *
 * Two audiences, deliberately kept apart:
 *
 *  - Watched pipelines get told about a run *starting* and about it *finishing*,
 *    with the result. That is someone saying "I am waiting on this one".
 *  - Starred pipelines get a lighter alert -- red, and back to green -- and
 *    anything already watched is skipped so a failure never arrives twice.
 *
 * The run counter is remembered alongside the status, because between two polls
 * a pipeline can start and finish. Comparing statuses alone would see no change
 * and say nothing; comparing counters catches it.
 */
async function announceChanges(pipelines, { silent = false } = {}) {
  const settings = await getSettings();
  const previous = await getSeenStatus();
  const favorites = new Set(await getFavorites());
  const watched = new Set(await getWatched());
  const next = {};
  const events = [];

  for (const pipeline of pipelines) {
    const status = pipelineStatus(pipeline);
    const counter = pipeline._embedded?.instances?.[0]?.counter ?? null;
    next[pipeline.name] = { status, counter };

    // Older builds stored a bare status string; read both shapes.
    const before = previous[pipeline.name];
    const wasStatus = typeof before === 'string' ? before : before?.status;
    const wasCounter = typeof before === 'string' ? null : (before?.counter ?? null);
    if (!wasStatus) continue;

    const newRun = counter != null && wasCounter != null && counter !== wasCounter;
    const running = status === 'Building' || status === 'Scheduled';
    const wasRunning = wasStatus === 'Building' || wasStatus === 'Scheduled';

    if (watched.has(pipeline.name)) {
      if (running && (!wasRunning || newRun)) {
        events.push({ pipeline: pipeline.name, kind: 'started', counter });
      } else if (
        !running &&
        status !== 'Unknown' &&
        // Finished while we were watching, or finished a run we never saw
        // start, or simply came back with a different answer than last time --
        // a stage re-run keeps the same counter but changes the outcome.
        (wasRunning || newRun || wasStatus !== status)
      ) {
        events.push({
          pipeline: pipeline.name,
          kind: 'finished',
          status,
          counter,
          stage: failedStage(pipeline),
        });
      }
      continue; // a watched pipeline is already covered; do not also alert on it
    }

    // Starred pipelines get the lighter alert: the two transitions that matter,
    // and nothing while the state simply persists.
    if (wasStatus === status) continue;
    if (!settings.notifyStarred || !favorites.has(pipeline.name)) continue;

    if (status === 'Failed') {
      events.push({ pipeline: pipeline.name, kind: 'failed' });
    } else if (wasStatus === 'Failed' && status === 'Passed') {
      events.push({ pipeline: pipeline.name, kind: 'recovered' });
    }
  }

  await setSeenStatus(next);
  if (silent || !settings.notifications) return;

  // A burst is worth one sound, not five overlapping ones.
  let sound = null;
  for (const event of events.slice(0, 5)) {
    const card = notificationFor(event);
    chrome.notifications.create(`pipeline:${event.pipeline}`, card.options);
    sound = louder(sound, card.sound);
  }
  // Awaited so the chime is dispatched before the refresh reports done; the
  // offscreen document can take a moment to come up on the first one.
  if (sound) await playSound(sound, settings);
}

/** Which stage went red, so the notification says where to look. */
function failedStage(pipeline) {
  const stages = pipeline._embedded?.instances?.[0]?._embedded?.stages || [];
  return stages.find((stage) => stageStatus(stage) === 'Failed')?.name || null;
}

const SOUND_RANK = { start: 0, success: 1, failure: 2 };

function louder(current, candidate) {
  if (!candidate) return current;
  if (!current) return candidate;
  return SOUND_RANK[candidate] > SOUND_RANK[current] ? candidate : current;
}

function notificationFor(event) {
  const run = event.counter ? ` #${event.counter}` : '';
  const base = {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
  };

  switch (event.kind) {
    case 'started':
      return {
        sound: 'start',
        options: {
          ...base,
          title: 'Started',
          message: `${event.pipeline}${run} is running.`,
          priority: 0,
        },
      };

    case 'finished': {
      const passed = event.status === 'Passed';
      const cancelled = event.status === 'Cancelled';
      let message;
      if (passed) message = `${event.pipeline}${run} finished. No failures.`;
      else if (cancelled) message = `${event.pipeline}${run} was cancelled.`;
      else if (event.stage) message = `${event.pipeline}${run} failed at the ${event.stage} stage.`;
      else message = `${event.pipeline}${run} finished with failures.`;

      return {
        sound: passed ? 'success' : 'failure',
        options: {
          ...base,
          title: passed ? 'Passed' : cancelled ? 'Cancelled' : 'Failed',
          message,
          // A failure stays on screen until it is acknowledged; a pass does not
          // need to interrupt anyone twice.
          priority: passed ? 0 : 2,
          requireInteraction: !passed && !cancelled,
        },
      };
    }

    case 'recovered':
      return {
        sound: 'success',
        options: { ...base, title: 'Back to green', message: `${event.pipeline} is passing again.`, priority: 0 },
      };

    default:
      return {
        sound: 'failure',
        options: { ...base, title: 'Pipeline failed', message: `${event.pipeline} just turned red.`, priority: 2 },
      };
  }
}

// ------------------------------------------------------------------ sound

/**
 * A Manifest V3 service worker has no DOM and so cannot play audio at all. An
 * offscreen document is Chrome's supported way round that; it is created on the
 * first chime and then reused.
 */
let offscreenReady = null;

async function ensureOffscreen() {
  if (!chrome.offscreen) throw new Error('offscreen documents are unavailable');
  if (await chrome.offscreen.hasDocument()) return;
  if (!offscreenReady) {
    offscreenReady = chrome.offscreen
      .createDocument({
        url: 'src/offscreen/offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'Play a short chime when a watched pipeline starts or finishes.',
      })
      .finally(() => {
        offscreenReady = null;
      });
  }
  await offscreenReady;
}

async function playSound(name, settings) {
  if (!settings.sound) return { ok: false, error: 'sound is switched off' };
  try {
    await ensureOffscreen();
    return await dispatchSound({ name });
  } catch (err) {
    // The chime is a nicety. A browser that will not play it must never cost
    // the notification that actually matters.
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Hand the chime to the offscreen page, retrying briefly.
 *
 * `createDocument()` resolves once the document exists, which is *before* its
 * module script has run and registered a listener. A message sent in that gap
 * is simply dropped -- which is why the first chime after the page was created
 * could silently do nothing.
 */
async function dispatchSound(payload, attempts = 6) {
  let last = 'the audio page never answered';

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'playSound',
        payload,
      });
      // A reply of any shape means the page was listening, so stop retrying:
      // a refusal from the autoplay policy will not improve with another go.
      if (response) return response;
      last = 'the audio page answered with nothing';
    } catch (err) {
      last = err?.message || String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
  }

  return { ok: false, error: last };
}

// -------------------------------------------------------------- diagnostics

/**
 * The reason this extension exists: when the GoCD web UI is restarting or has
 * lost your pipelines, this shows that the API underneath it is answering fine.
 */
async function diagnose() {
  const conn = await getConnection();
  if (!conn) return { configured: false };
  const api = new GoCdClient(conn);

  const probes = [
    { id: 'version', label: 'GoCD API', run: () => api.version() },
    { id: 'identity', label: 'Your identity', run: () => api.currentUser() },
    { id: 'dashboard', label: 'Pipeline data', run: () => api.dashboard({}) },
  ];

  const results = [];
  for (const probe of probes) {
    const startedAt = performance.now();
    try {
      const data = await probe.run();
      results.push({
        id: probe.id,
        label: probe.label,
        ok: true,
        ms: Math.round(performance.now() - startedAt),
        detail: summariseProbe(probe.id, data),
      });
    } catch (err) {
      results.push({
        id: probe.id,
        label: probe.label,
        ok: false,
        ms: Math.round(performance.now() - startedAt),
        detail: describe(err),
      });
    }
  }

  // Separately: is the web UI itself serving pages? This is the thing that
  // breaks; the answer is what tells you "it's them, not you".
  const startedAt = performance.now();
  try {
    const response = await fetch(`${api.base}/`, {
      credentials: conn.authMode === 'session' ? 'include' : 'omit',
      cache: 'no-store',
      redirect: 'follow',
    });
    results.push({
      id: 'webui',
      label: 'GoCD web UI',
      ok: response.ok,
      ms: Math.round(performance.now() - startedAt),
      detail: response.ok ? `HTTP ${response.status}` : `HTTP ${response.status} - the web UI is unhappy, the API above is what matters here`,
    });
  } catch (err) {
    results.push({
      id: 'webui',
      label: 'GoCD web UI',
      ok: false,
      ms: Math.round(performance.now() - startedAt),
      detail: String(err?.message || err),
    });
  }

  return { configured: true, serverUrl: api.base, probes: results };
}

function summariseProbe(id, data) {
  if (id === 'version') return `GoCD ${data?.version || 'unknown'}`;
  if (id === 'identity') return data?.login_name ? `signed in as ${data.login_name}` : 'signed in';
  if (id === 'dashboard') return `${(data?.pipelines || []).length} pipelines visible`;
  return 'ok';
}

/**
 * Starring or watching something changes what a built-in view contains, and the
 * cached payload was filtered with the old list. Re-fetch, but only when one of
 * those views is actually on screen.
 */
async function refreshBuiltinView() {
  const settings = await getSettings();
  if (!isBuiltinView(settings.activeView)) return;
  try {
    await refreshDashboard({ force: true });
  } catch {
    // The star is saved either way; the list catches up on the next poll.
  }
}

/**
 * The settings page never receives a stored secret, so when the user edits a
 * connection without retyping it, it sends a flag instead and the real value is
 * carried over here.
 */
async function mergeKeptSecret(connection) {
  const merged = { ...connection };
  if (!merged.keepExistingSecret) return merged;
  delete merged.keepExistingSecret;
  const existing = await getConnection();
  if (existing && existing.authMode === merged.authMode) {
    if (merged.authMode === 'token') merged.token = existing.token;
    if (merged.authMode === 'basic') merged.password = existing.password;
  }
  return merged;
}

// ---------------------------------------------------------------- messaging

/**
 * One entry point. Every handler returns plain data; nothing here ever returns
 * a token or a password to a page.
 */
const handlers = {
  async getState() {
    const conn = await getConnection();
    const [settings, favorites, watched, cache, recent, expandedGroups] = await Promise.all([
      getSettings(),
      getFavorites(),
      getWatched(),
      getCache(),
      getRecent(),
      getExpandedGroups(),
    ]);
    // From cache, so a popup opens instantly and still works offline.
    const views = await getViewDefinitions();
    return {
      connection: redactConnection(conn),
      hasPermission: conn ? await hasHostPermission(conn.serverUrl) : false,
      settings,
      favorites,
      watched,
      cache,
      recent,
      expandedGroups,
      views,
    };
  },

  async setExpandedGroups({ names }) {
    return setExpandedGroups(names || []);
  },

  async saveConnection({ connection }) {
    const merged = await mergeKeptSecret(connection);
    // Prove the credential works before storing it, so a typo surfaces here
    // rather than as an empty dashboard later.
    const api = new GoCdClient(merged);
    const version = await api.version();
    let user = null;
    try {
      user = await api.currentUser();
    } catch {
      // Some GoCD deployments restrict /api/current_user; not fatal.
    }
    await setConnection(merged);
    await chrome.storage.local.remove(['dashboardCache', 'lastSeenStatus']);
    await ensureAlarm();
    return { version: version?.version || null, user: user?.login_name || null };
  },

  async testConnection({ connection }) {
    const api = new GoCdClient(connection);
    const version = await api.version();
    const dashboard = await api.dashboard({});
    return {
      version: version?.version || null,
      pipelines: (dashboard.pipelines || []).length,
      groups: (dashboard.groups || []).length,
    };
  },

  async disconnect() {
    await clearConnection();
    await chrome.action.setBadgeText({ text: '' });
    return { ok: true };
  },

  async updateSettings({ patch }) {
    const settings = await setSettings(patch);
    // Either of these changes what the alarm should be, or whether there is one.
    if ('notifyWhenClosed' in patch || 'backgroundMinutes' in patch) await ensureAlarm();
    if ('badgeSource' in patch) {
      const cache = await getCache();
      if (cache) await setBadge({ pipelines: cache.pipelines });
    }
    return settings;
  },

  async toggleWatched({ name }) {
    const watched = await toggleWatched(name);
    await refreshBuiltinView();
    const cache = await getCache();
    if (cache) await setBadge({ pipelines: cache.pipelines });
    return watched;
  },

  /**
   * Whether Chrome will show a notification at all.
   *
   * This reports Chrome's own setting. It cannot see the operating system's --
   * on macOS, System Settings can silence Chrome entirely while this still says
   * "granted" -- which is why the settings page offers a test notification
   * rather than trusting this alone.
   */
  async notificationStatus() {
    try {
      const level = await chrome.notifications.getPermissionLevel();
      return { level };
    } catch (err) {
      return { level: 'unknown', error: err?.message || String(err) };
    }
  },

  /** The only check that covers the operating system too: try one and look. */
  async testNotification() {
    const id = `test:${Date.now()}`;
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'GoCD Lens works',
      message: 'This is what a pipeline notification will look like.',
      priority: 2,
    });
    // Deliberately not forcing sound on: a test should show what a real one
    // will do, and a real one is silent when chimes are off.
    const settings = await getSettings();
    await playSound('success', settings);
    return { ok: true, id };
  },

  /** Let the user hear what they are signing up for before they sign up. */
  async previewSound({ name }) {
    const settings = await getSettings();
    // A preview plays whatever the master toggle says, because deciding whether
    // you want the sound on requires hearing it first. The result comes back so
    // a preview that made no noise can say why.
    return playSound(name, { ...settings, sound: true });
  },

  async toggleFavorite({ name }) {
    const favorites = await toggleFavorite(name);
    await refreshBuiltinView();
    const cache = await getCache();
    if (cache) await setBadge({ pipelines: cache.pipelines });
    return favorites;
  },

  refresh({ force, view }) {
    return refreshDashboard({ force, view });
  },

  async history({ pipeline, after }) {
    const api = await client();
    if (after == null) await pushRecent(pipeline);
    return api.history(pipeline, { after });
  },

  async instance({ pipeline, counter }) {
    const api = await client();
    return api.instance(pipeline, counter);
  },

  async views() {
    const api = await client();
    const result = await api.views();
    await setViewDefinitions(result.filters);
    return result;
  },

  async saveView({ name, pipelines }) {
    const api = await client();
    await api.saveView(name, pipelines);
    // Hand back the fresh list so the caller does not have to re-ask.
    const result = await api.views();
    await setViewDefinitions(result.filters);
    return result;
  },

  async artifacts({ pipeline, counter, stage, stageCounter, job }) {
    const api = await client();
    return api.artifacts(pipeline, counter, stage, stageCounter, job);
  },

  async consoleLog({ pipeline, counter, stage, stageCounter, job, startLine }) {
    const api = await client();
    const text = await api.consoleLog(pipeline, counter, stage, stageCounter, job, startLine);
    return { text };
  },

  async trigger({ pipeline, environmentVariables }) {
    const api = await client();
    await api.trigger(pipeline, environmentVariables || []);
    return { ok: true };
  },

  async pause({ pipeline, cause }) {
    const api = await client();
    await api.pause(pipeline, cause);
    return { ok: true };
  },

  async unpause({ pipeline }) {
    const api = await client();
    await api.unpause(pipeline);
    return { ok: true };
  },

  async cancelStage({ pipeline, counter, stage, stageCounter }) {
    const api = await client();
    await api.cancelStage(pipeline, counter, stage, stageCounter);
    return { ok: true };
  },

  async rerun({ pipeline, counter, stage, stageCounter, failedOnly, jobs }) {
    const api = await client();
    if (jobs?.length) await api.rerunSelectedJobs(pipeline, counter, stage, stageCounter, jobs);
    else if (failedOnly) await api.rerunFailedJobs(pipeline, counter, stage, stageCounter);
    else await api.rerunStage(pipeline, counter, stage, stageCounter);
    return { ok: true };
  },

  async webUrl({ kind, parts }) {
    const api = await client();
    return { url: api.webUrl(kind, parts) };
  },

  diagnose,

  async wipe() {
    await wipeEverything();
    await chrome.action.setBadgeText({ text: '' });
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only this extension's own pages may drive it. There are no content scripts,
  // so a message carrying a different id or an http(s) origin is not ours.
  if (sender.id !== chrome.runtime.id) return false;

  const handler = handlers[message?.type];
  if (!handler) {
    sendResponse({ ok: false, error: `Unknown request: ${message?.type}` });
    return false;
  }

  Promise.resolve(handler(message.payload || {}))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) =>
      sendResponse({
        ok: false,
        error: describe(err),
        kind: err instanceof GoCdError ? err.kind : 'unknown',
        status: err instanceof GoCdError ? err.status : 0,
      }),
    );
  return true; // keep the channel open for the async reply
});
