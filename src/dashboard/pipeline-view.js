/**
 * One pipeline: its run history on the left, the selected run's stages, jobs
 * and materials on the right. This is the screen that replaces the GoCD
 * pipeline page when that page will not load.
 */

import { el, icon, send, explain, copyToClipboard } from '../common/ui.js';
import {
  runStatus,
  stageStatus,
  pipelineStatus,
  isActive,
  jobStatus,
  timeAgo,
  absoluteTime,
  gitRefs,
  upstreamDeps,
  commitUrl,
} from '../lib/status.js';
import {
  state,
  navigate,
  statusPill,
  pipelineByName,
  groupOf,
  isFavorite,
  isWatched,
  toggleStar,
  toggleWatch,
  triggerPipeline,
  togglePause,
  cancelStage,
  rerunStage,
  openInGoCd,
  rerender,
} from './state.js';
import { openJobViewer } from './job-viewer.js';

/** Per-pipeline history, kept between renders so paging and selection survive. */
const historyCache = new Map();

export function renderPipeline(host, name) {
  const pipeline = pipelineByName(name);
  const entry = historyCache.get(name);

  host.append(header(name, pipeline));

  if (!entry) {
    host.append(skeleton());
    loadHistory(name, { reset: true });
    return;
  }

  if (entry.loading && entry.runs.length === 0) {
    host.append(skeleton());
    return;
  }

  if (entry.error) {
    host.append(
      el(
        'div',
        { class: 'banner banner-error' },
        icon('alert'),
        el('span', { text: entry.error }),
        el(
          'span',
          { class: 'banner-actions' },
          el('button', { class: 'btn btn-sm', text: 'Try again', onclick: () => loadHistory(name, { reset: true }) }),
        ),
      ),
    );
    return;
  }

  const selected = entry.runs.find((r) => r.counter === entry.selected) || entry.runs[0];

  // The dashboard payload and the history page are separate endpoints and the
  // history one lags: a run can be live on the dashboard seconds before it
  // shows up here. Say so, rather than letting the page look simply wrong.
  const latestKnown = pipeline?._embedded?.instances?.[0];
  if (latestKnown && (!selected || latestKnown.counter > selected.counter)) {
    host.append(
      el(
        'div',
        { class: 'banner banner-info', style: { marginBottom: '14px' } },
        icon('activity'),
        el('span', {
          text: `Run #${latestKnown.counter} has started. GoCD has not published it to the run history yet -- it will appear here shortly.`,
        }),
        el(
          'span',
          { class: 'banner-actions' },
          el('button', {
            class: 'btn btn-sm',
            text: 'Check now',
            onclick: () => loadHistory(name, { reset: true }),
          }),
        ),
      ),
    );
  }

  host.append(
    el(
      'div',
      { class: 'split' },
      historyPanel(name, entry, selected),
      selected ? runPanel(name, selected) : el('div', { class: 'panel' }, el('div', { class: 'empty' }, el('p', { text: 'This pipeline has never run.' }))),
    ),
  );

  // Paging older runs re-renders the page, which rebuilds this list from
  // scratch and would otherwise drop you back at the newest run -- the one
  // place you were not looking. `host` is already in the document here, so the
  // list is live and its scroll position takes effect immediately.
  if (entry.scrollTop) {
    const list = host.querySelector('.run-list');
    if (list) list.scrollTop = entry.scrollTop;
  }
}

function skeleton() {
  return el('div', { class: 'grid' }, ...[0, 1, 2].map(() => el('div', { class: 'skeleton' })));
}

// ----------------------------------------------------------------- header

function header(name, pipeline) {
  const paused = Boolean(pipeline?.pause_info?.paused);
  const starred = isFavorite(name);
  const watching = isWatched(name);
  const group = groupOf(name);

  return el(
    'div',
    { class: 'detail-head' },
    el('button', { class: 'icon-btn', title: 'Back to all pipelines', onclick: () => navigate({ kind: 'list' }) }, icon('chevron-left')),
    el(
      'div',
      {},
      el('h1', { text: name }),
      group && el('div', { class: 'crumb', text: group }),
    ),
    paused && el('span', { class: 'paused-flag' }, icon('pause', { size: 13 }), 'Paused'),
    el(
      'div',
      { class: 'detail-actions' },
      el(
        'button',
        {
          class: `icon-btn${watching ? ' watching' : ''}`,
          title: watching ? 'Stop notifying me about this' : 'Notify me when this starts and finishes',
          onclick: () => toggleWatch(name),
        },
        icon(watching ? 'bell-filled' : 'bell'),
      ),
      el('button', { class: `icon-btn${starred ? ' starred' : ''}`, title: starred ? 'Unstar' : 'Star', onclick: () => toggleStar(name) }, icon(starred ? 'star-filled' : 'star')),
      el('button', { class: 'btn btn-sm', onclick: () => triggerPipeline(name) }, icon('play', { size: 13 }), 'Run'),
      pipeline &&
        el('button', { class: 'btn btn-sm', onclick: () => togglePause(pipeline) }, icon(paused ? 'play' : 'pause', { size: 13 }), paused ? 'Resume' : 'Pause'),
      el('button', { class: 'btn btn-sm', title: 'Open this pipeline in the GoCD web UI', onclick: () => openInGoCd('pipeline', { pipeline: name }) }, icon('external', { size: 13 }), 'GoCD'),
      el('button', { class: 'icon-btn', title: 'Reload history', onclick: () => loadHistory(name, { reset: true }) }, icon('refresh')),
    ),
  );
}

// ---------------------------------------------------------------- history

function historyPanel(name, entry, selected) {
  const list = el('div', { class: 'run-list' });

  for (const run of entry.runs) {
    const status = runStatus(run);
    const author = run.build_cause?.approver || firstAuthor(run);
    list.append(
      el(
        'button',
        {
          class: 'run-row',
          'aria-current': String(selected?.counter === run.counter),
          onclick: () => {
            entry.selected = run.counter;
            rerender();
          },
        },
        el('span', { class: 'run-counter', text: `#${run.counter}` }),
        el(
          'span',
          { class: 'run-body' },
          el('span', { class: 'run-label truncate', text: run.label || `Run ${run.counter}` }),
          el('span', {
            class: 'run-sub truncate',
            text: [timeAgo(run.scheduled_date), author].filter(Boolean).join(' - '),
            title: absoluteTime(run.scheduled_date),
          }),
        ),
        statusPill(status),
      ),
    );
  }

  if (entry.next != null) {
    list.append(
      el('button', {
        class: 'load-more',
        text: entry.loading ? 'Loading...' : 'Load older runs',
        disabled: entry.loading,
        onclick: () => loadHistory(name),
      }),
    );
  } else if (entry.runs.length) {
    list.append(el('div', { class: 'load-more faint', text: 'That is the whole history.' }));
  }

  // Reaching the bottom pages automatically, so scrolling just keeps working.
  list.addEventListener('scroll', () => {
    // Kept on the cache entry, which outlives the render that rebuilt this list.
    entry.scrollTop = list.scrollTop;
    if (entry.loading || entry.next == null) return;
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 80) loadHistory(name);
  });

  return el(
    'div',
    { class: 'panel' },
    el('div', { class: 'panel-head' }, icon('clock', { size: 13 }), 'Run history', el('span', { class: 'spacer' }), el('span', { text: String(entry.runs.length) })),
    list,
  );
}

function firstAuthor(run) {
  for (const revision of run.build_cause?.material_revisions || []) {
    const user = revision.modifications?.[0]?.user_name;
    if (user) return user.replace(/\s*<[^>]*>\s*$/, '');
  }
  return '';
}

async function loadHistory(name, { reset = false } = {}) {
  const existing = historyCache.get(name);
  // A reset throws away the pages but not where you were looking or which run
  // you had open. The poll tick resets on every cycle while a run is building,
  // so without this the list would snap to the top roughly every ten seconds.
  const entry =
    reset || !existing
      ? {
          runs: [],
          next: null,
          selected: existing?.selected ?? null,
          scrollTop: existing?.scrollTop ?? 0,
          loading: true,
          error: null,
        }
      : existing;
  if (!reset && entry.loading) return;
  entry.loading = true;
  entry.error = null;
  historyCache.set(name, entry);
  if (reset) rerender();

  try {
    const after = reset ? null : entry.next;
    const { runs, next } = await send('history', { pipeline: name, after });
    entry.runs = reset ? runs : [...entry.runs, ...runs];
    entry.next = next;
    entry.at = Date.now();
    if (entry.selected == null) entry.selected = entry.runs[0]?.counter ?? null;
  } catch (err) {
    entry.error = explain(err);
  } finally {
    entry.loading = false;
    rerender();
  }
}

/** Called by the auto-refresh tick so an open pipeline page stays live too. */
export function refreshOpenPipeline() {
  if (state.route.kind !== 'pipeline') return;
  const entry = historyCache.get(state.route.name);
  if (!entry || entry.loading) return;
  const selected = entry.runs.find((r) => r.counter === entry.selected);
  // Trust either source: the dashboard payload knows a pipeline is running even
  // in the moment before its history page catches up, and without this a run
  // that looked idle would never be polled again to find out otherwise.
  const dashboardSaysBusy = isActive(pipelineStatus(pipelineByName(state.route.name)));
  const historySaysBusy = selected && isActive(runStatus(selected));
  const busy = dashboardSaysBusy || historySaysBusy;
  // Only re-fetch when something is actually moving, or the first page is old.
  if (!busy && Date.now() - (entry.at || 0) < 60_000) return;
  loadHistory(state.route.name, { reset: true });
}

// -------------------------------------------------------------------- run

function runPanel(name, run) {
  const status = runStatus(run);

  const head = el(
    'div',
    { class: 'panel-head' },
    icon('layers', { size: 13 }),
    `Run #${run.counter}`,
    el('span', { class: 'spacer' }),
    statusPill(status),
    el('button', { class: 'icon-btn', title: 'Open this run in the GoCD web UI', onclick: () => openInGoCd('run', { pipeline: name, counter: run.counter }) }, icon('external')),
  );

  const meta = el(
    'div',
    { class: 'material' },
    icon('clock'),
    el(
      'div',
      { class: 'material-body' },
      el('div', { class: 'material-title', text: run.label || `Run ${run.counter}` }),
      el('div', { class: 'material-msg faint', text: [absoluteTime(run.scheduled_date), run.build_cause?.trigger_message].filter(Boolean).join(' - ') }),
    ),
  );

  const stages = el('div', { class: 'stage-list' });
  for (const stage of run.stages || []) stages.append(stageCard(name, run, stage));

  return el(
    'div',
    {},
    el('div', { class: 'panel' }, head, meta, stages),
    materialsPanel(name, run),
  );
}

function stageCard(pipeline, run, stage) {
  const status = stageStatus(stage);
  const stageCounter = String(stage.counter ?? '1');
  const manualPending = stage.approval_type === 'manual' && status === 'Unknown';
  const runnable = (stage.jobs || []).filter((job) => job?.name);

  // A stage with one job has nothing to choose between, and a stage that has not
  // run or is still running cannot be re-run at all.
  const picking = !isActive(status) && status !== 'Unknown' && runnable.length > 1;

  /** Job name -> its checkbox, so the button can read the selection. */
  const boxes = new Map();
  const chosen = () => [...boxes].filter(([, box]) => box.checked).map(([name]) => name);

  const rerunText = el('span', { text: 'Re-run' });
  let selectAll = null;

  /**
   * The button says what it will actually do. Every job ticked is the same
   * operation as re-running the stage, so it reads "Re-run" then too rather
   * than claiming a selection that is not really one.
   */
  function syncRerun() {
    const count = chosen().length;
    const whole = count === 0 || count === boxes.size;
    rerunText.textContent = whole ? 'Re-run' : `Re-run selected (${count})`;
    if (selectAll) {
      selectAll.checked = count === boxes.size && count > 0;
      selectAll.indeterminate = count > 0 && count < boxes.size;
    }
  }

  const actions = el('div', { class: 'stage-actions' });

  if (picking) {
    selectAll = el('input', {
      type: 'checkbox',
      onchange: () => {
        for (const box of boxes.values()) box.checked = selectAll.checked;
        syncRerun();
      },
    });
    actions.append(
      el(
        'label',
        { class: 'job-check', title: 'Select or clear every job in this stage' },
        selectAll,
      ),
    );
  }

  if (isActive(status)) {
    actions.append(
      el('button', { class: 'btn btn-sm', title: 'Cancel this running stage', onclick: () => cancelStage({ pipeline, counter: run.counter, stage: stage.name, stageCounter }) }, icon('stop', { size: 12 }), 'Stop'),
    );
  } else if (status !== 'Unknown') {
    actions.append(
      el(
        'button',
        {
          class: 'btn btn-sm',
          title: picking
            ? 'Run the ticked jobs again, or the whole stage when none are ticked'
            : 'Run this stage again',
          onclick: () =>
            rerunStage({
              pipeline,
              counter: run.counter,
              stage: stage.name,
              stageCounter,
              jobs: runnable,
              selected: picking ? chosen() : null,
            }),
        },
        icon('rerun', { size: 12 }),
        rerunText,
      ),
    );
  }

  actions.append(
    el('button', { class: 'icon-btn', title: 'Open this stage in the GoCD web UI', onclick: () => openInGoCd('stage', { pipeline, counter: run.counter, stage: stage.name, stageCounter }) }, icon('external')),
  );

  const jobs = el('div', { class: 'job-list' });
  for (const job of stage.jobs || []) {
    const jobState = jobStatus(job);
    const open = el(
      'button',
      {
        class: 'job-open',
        onclick: () =>
          openJobViewer({
            pipeline,
            counter: run.counter,
            stage: stage.name,
            stageCounter,
            job: job.name,
            live: isActive(status),
          }),
      },
      icon('terminal', { size: 13 }),
      el('span', { class: 'job-name truncate', text: job.name }),
      statusPill(jobState),
      icon('chevron-right', { size: 13 }),
    );

    if (!picking || !job.name) {
      jobs.append(el('div', { class: 'job-row' }, open));
      continue;
    }

    // Failed jobs arrive ticked: retrying what broke is the common case, and a
    // picker that starts empty would cost a click per job to get back here.
    const box = el('input', { type: 'checkbox', checked: jobState === 'Failed', onchange: syncRerun });
    boxes.set(job.name, box);
    jobs.append(
      el(
        'div',
        { class: 'job-row' },
        el('label', { class: 'job-check', title: `Include ${job.name} in the next re-run` }, box),
        open,
      ),
    );
  }

  syncRerun();

  return el(
    'div',
    { class: 'stage-card' },
    el(
      'div',
      { class: 'stage-head' },
      el('span', { class: 'stage-name', text: stage.name }),
      statusPill(status),
      manualPending && el('span', { class: 'manual-gate' }, icon('lock', { size: 12 }), 'Waiting for approval'),
      actions,
    ),
    jobs,
  );
}

// -------------------------------------------------------------- materials

function materialsPanel(name, run) {
  const refs = gitRefs(run);
  const deps = upstreamDeps(run);
  if (refs.length === 0 && deps.length === 0) return el('span');

  const panel = el(
    'div',
    { class: 'panel', style: { marginTop: '12px' } },
    el('div', { class: 'panel-head' }, icon('commit', { size: 13 }), 'What this run was built from'),
  );

  for (const ref of refs) {
    const short = ref.sha.slice(0, 8);
    const message = (ref.modification?.comment || '').trim();

    panel.append(
      el(
        'div',
        { class: 'material' },
        icon('git-branch'),
        el(
          'div',
          { class: 'material-body' },
          el(
            'div',
            { class: 'row' },
            el('span', { class: 'material-title truncate', text: `${ref.owner}/${ref.repo}` }),
            el('span', { class: 'faint', text: ref.branch }),
          ),
          message && el('div', { class: 'material-msg', text: message }),
          el(
            'div',
            { class: 'row', style: { marginTop: '6px' } },
            el('button', { class: 'sha', title: 'Copy the full commit SHA', onclick: () => copyToClipboard(ref.sha) }, short),
            ref.modification?.user_name && el('span', { class: 'faint', text: ref.modification.user_name.replace(/\s*<[^>]*>\s*$/, '') }),
            el('button', { class: 'btn btn-sm btn-ghost', onclick: () => chrome.tabs.create({ url: commitUrl(ref) }) }, icon('external', { size: 12 }), 'View commit'),
          ),
        ),
      ),
    );
  }

  for (const dep of deps) {
    panel.append(
      el(
        'div',
        { class: 'material' },
        icon('layers'),
        el(
          'div',
          { class: 'material-body' },
          el('div', { class: 'material-title', text: `Triggered by ${dep.name} #${dep.counter}` }),
          el('button', {
            class: 'btn btn-sm btn-ghost',
            text: 'Open that pipeline',
            onclick: () => navigate({ kind: 'pipeline', name: dep.name }),
          }),
        ),
      ),
    );
  }

  return panel;
}
