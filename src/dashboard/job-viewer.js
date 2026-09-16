/**
 * The job viewer: live console output, the artifact tree, and a download.
 *
 * Log text is the least trustworthy data in the whole extension -- it is
 * whatever a build happened to print. Every line goes on screen through
 * `textContent`, and the search highlighter splits text nodes rather than
 * building markup, so nothing a build writes can become HTML here.
 */

import { $, el, icon, clear, send, toast, explain, copyToClipboard } from '../common/ui.js';
import { parseLogLine, flattenArtifacts } from '../lib/status.js';
import { openInGoCd } from './state.js';

/** Enough to scroll through; the full log is always one click from a download. */
const MAX_RENDERED_LINES = 6000;
const TAIL_INTERVAL_MS = 3000;

let session = null;

export function openJobViewer(target) {
  closeSession();

  session = {
    target,
    tab: 'console',
    lines: [],
    nextLine: 0,
    follow: true,
    wrap: false,
    query: '',
    matchIndex: 0,
    matchNodes: [],
    artifacts: null,
    expanded: new Set(),
    timer: null,
    loading: true,
    error: null,
    finished: !target.live,
  };

  const dialog = $('#viewer');
  paintChrome();
  dialog.showModal();
  dialog.addEventListener('close', closeSession, { once: true });
  $('#viewer-close').onclick = () => dialog.close();

  loadConsole({ initial: true });
  if (target.live) startTail();
}

function closeSession() {
  if (session?.timer) clearInterval(session.timer);
  if (session?.searchTimer) clearTimeout(session.searchTimer);
  session = null;
}

// ------------------------------------------------------------------ chrome

function paintChrome() {
  const { pipeline, counter, stage, job } = session.target;

  const title = clear($('#viewer-title'));
  title.append(
    el('span', { text: job }),
    el('span', { class: 'crumb', text: `  ${pipeline} #${counter} / ${stage}` }),
  );

  const tabs = clear($('#viewer-tabs'));
  for (const [id, label] of [
    ['console', 'Console'],
    ['artifacts', 'Artifacts'],
  ]) {
    tabs.append(
      el('button', {
        class: 'tab',
        role: 'tab',
        'aria-selected': String(session.tab === id),
        text: label,
        onclick: () => switchTab(id),
      }),
    );
  }

  paintToolbar();
}

/**
 * Kept as its own node so following can be toggled without repainting the
 * toolbar -- repainting would rebuild the search box and steal the caret.
 */
function followButton() {
  const button = el(
    'button',
    {
      class: `btn btn-sm${session.follow ? ' follow-on' : ''}`,
      title: 'Keep scrolling as new output arrives',
      onclick: () => setFollow(!session.follow),
    },
    icon(session.follow ? 'check' : 'arrow-down', { size: 12 }),
    'Follow',
  );
  session.followButton = button;
  return button;
}

function setFollow(on) {
  session.follow = on;
  const button = session.followButton;
  if (button) {
    button.classList.toggle('follow-on', on);
    clear(button).append(icon(on ? 'check' : 'arrow-down', { size: 12 }), document.createTextNode('Follow'));
  }
  if (on) scrollToBottom();
}

function switchTab(tab) {
  session.tab = tab;
  paintChrome();
  if (tab === 'artifacts' && session.artifacts === null) loadArtifacts();
  else renderBody();
}

function paintToolbar() {
  const bar = clear($('#viewer-toolbar'));
  const { pipeline, counter, stage, stageCounter, job } = session.target;

  if (session.tab === 'console') {
    const search = el('input', {
      type: 'text',
      placeholder: 'Find in this log',
      value: session.query,
      spellcheck: false,
      oninput: (event) => {
        // Re-rendering thousands of lines on every keystroke is what makes a
        // log search feel broken, so wait for a pause in typing.
        session.query = event.target.value;
        session.matchIndex = 0;
        clearTimeout(session.searchTimer);
        session.searchTimer = setTimeout(() => renderBody({ keepScroll: true }), 120);
      },
      onkeydown: (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          stepMatch(event.shiftKey ? -1 : 1);
        }
      },
    });

    bar.append(
      el('div', { class: 'search-wrap' }, el('span', { class: 'search-icon' }, icon('search', { size: 14 })), search),
      el('button', { class: 'icon-btn', title: 'Previous match', onclick: () => stepMatch(-1) }, icon('chevron-left')),
      el('button', { class: 'icon-btn', title: 'Next match', onclick: () => stepMatch(1) }, icon('chevron-right')),
      el('span', { class: 'faint', id: 'match-count' }),
      el('span', { class: 'spacer' }),
      followButton(),
      el(
        'button',
        {
          class: 'btn btn-sm',
          title: 'Wrap long lines',
          onclick: () => {
            session.wrap = !session.wrap;
            renderBody({ keepScroll: true });
          },
        },
        session.wrap ? 'No wrap' : 'Wrap',
      ),
      el('button', { class: 'btn btn-sm', title: 'Save the whole log to a file', onclick: downloadLog }, icon('download', { size: 12 }), 'Download'),
      el('button', { class: 'btn btn-sm', title: 'Copy the whole log', onclick: () => copyToClipboard(session.lines.join('\n')) }, icon('copy', { size: 12 })),
    );
  } else {
    bar.append(
      el('span', { class: 'faint', text: 'Files this job published. Clicking one opens it in a new tab.' }),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn btn-sm', onclick: loadArtifacts }, icon('refresh', { size: 12 }), 'Reload'),
    );
  }

  bar.append(
    el(
      'button',
      {
        class: 'btn btn-sm',
        title: 'Open this job in the GoCD web UI',
        onclick: () => openInGoCd('job', { pipeline, counter, stage, stageCounter, job }),
      },
      icon('external', { size: 12 }),
      'GoCD',
    ),
  );
}

// ----------------------------------------------------------------- console

async function loadConsole({ initial = false } = {}) {
  const { pipeline, counter, stage, stageCounter, job } = session.target;
  const startLine = session.nextLine;

  try {
    const { text } = await send('consoleLog', { pipeline, counter, stage, stageCounter, job, startLine });
    const fresh = splitLines(text);
    if (fresh.length) {
      session.lines.push(...fresh);
      session.nextLine += fresh.length;
    }
    session.error = null;
  } catch (err) {
    // A log that does not exist yet is normal for a job that has not started.
    session.error = err.status === 404 && session.lines.length === 0
      ? 'No console output yet -- this job has not started writing anything.'
      : explain(err);
  } finally {
    session.loading = false;
    renderBody({ keepScroll: !initial && !session.follow });
    paintFooter();
  }
}

function splitLines(text) {
  if (!text) return [];
  const parts = text.split('\n');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function startTail() {
  session.timer = setInterval(async () => {
    if (!session) return;
    const before = session.lines.length;
    await loadConsole();
    if (!session) return;
    // No new output for a while on a job we were told is live: stop guessing
    // and let the user refresh, rather than polling a finished job forever.
    if (session.lines.length === before) session.idleTicks = (session.idleTicks || 0) + 1;
    else session.idleTicks = 0;
    if (session.idleTicks > 40) {
      clearInterval(session.timer);
      session.timer = null;
      session.finished = true;
      paintFooter();
    }
  }, TAIL_INTERVAL_MS);
}

// -------------------------------------------------------------- artifacts

async function loadArtifacts() {
  const { pipeline, counter, stage, stageCounter, job } = session.target;
  session.artifacts = 'loading';
  renderBody();
  try {
    session.artifacts = await send('artifacts', { pipeline, counter, stage, stageCounter, job });
  } catch (err) {
    session.artifacts = [];
    session.error = explain(err);
  }
  renderBody();
}

// ----------------------------------------------------------------- render

function renderBody({ keepScroll = false } = {}) {
  const body = $('#viewer-body');
  const previousScroll = body.scrollTop;
  clear(body);

  if (session.tab === 'artifacts') {
    renderArtifacts(body);
    return;
  }

  if (session.loading) {
    body.append(el('div', { class: 'empty' }, icon('refresh', { size: 22, class: 'spin' }), el('p', { text: 'Fetching console output...' })));
    return;
  }

  if (session.lines.length === 0) {
    body.append(
      el(
        'div',
        { class: 'empty' },
        icon('terminal', { size: 26 }),
        el('h3', { text: 'Nothing here yet' }),
        el('p', { text: session.error || 'This job has not printed anything.' }),
      ),
    );
    return;
  }

  const log = el('div', { class: `log${session.wrap ? ' wrap' : ''}` });
  const start = Math.max(0, session.lines.length - MAX_RENDERED_LINES);
  if (start > 0) {
    log.append(
      el('div', { class: 'log-line' }, el('span', { class: 'log-time' }), el('span', { class: 'log-text faint', text: `... ${start} earlier lines not shown -- use Download for the full log ...` })),
    );
  }

  session.matchNodes = [];
  const query = session.query.trim().toLowerCase();

  for (let i = start; i < session.lines.length; i += 1) {
    const { time, body: lineBody, severity } = parseLogLine(session.lines[i]);
    const text = el('span', { class: 'log-text' });
    if (query && lineBody.toLowerCase().includes(query)) {
      appendHighlighted(text, lineBody, session.query.trim());
    } else {
      text.textContent = lineBody;
    }
    log.append(el('div', { class: `log-line sev-${severity}` }, el('span', { class: 'log-time', text: time || '' }), text));
  }

  body.append(log);
  session.matchNodes = [...log.querySelectorAll('mark')];
  updateMatchCount();

  if (session.follow && !keepScroll) scrollToBottom();
  else body.scrollTop = previousScroll;
}

/** Split a line around the search term using text nodes and <mark>, never markup. */
function appendHighlighted(host, text, term) {
  const lowerText = text.toLowerCase();
  const lowerTerm = term.toLowerCase();
  let at = 0;
  for (;;) {
    const found = lowerText.indexOf(lowerTerm, at);
    if (found === -1) break;
    if (found > at) host.append(document.createTextNode(text.slice(at, found)));
    host.append(el('mark', { text: text.slice(found, found + term.length) }));
    at = found + term.length;
  }
  if (at < text.length) host.append(document.createTextNode(text.slice(at)));
}

function stepMatch(direction) {
  if (session.matchNodes.length === 0) return;
  session.matchNodes[session.matchIndex]?.classList.remove('current');
  session.matchIndex =
    (session.matchIndex + direction + session.matchNodes.length) % session.matchNodes.length;
  const node = session.matchNodes[session.matchIndex];
  node.classList.add('current');
  node.scrollIntoView({ block: 'center' });
  setFollow(false);
  updateMatchCount();
}

function updateMatchCount() {
  const label = $('#match-count');
  if (!label) return;
  if (!session.query.trim()) {
    label.textContent = '';
    return;
  }
  label.textContent = session.matchNodes.length
    ? `${session.matchIndex + 1} of ${session.matchNodes.length}`
    : 'no matches';
}

function renderArtifacts(body) {
  if (session.artifacts === 'loading') {
    body.append(el('div', { class: 'empty' }, icon('refresh', { size: 22, class: 'spin' }), el('p', { text: 'Listing files...' })));
    return;
  }

  const rows = flattenArtifacts(session.artifacts || [], session.expanded);
  if (rows.length === 0) {
    body.append(
      el('div', { class: 'empty' }, icon('folder', { size: 26 }), el('h3', { text: 'No artifacts' }), el('p', { text: 'This job did not publish any files.' })),
    );
    return;
  }

  const list = el('div', { style: { padding: '6px 0' } });
  for (const row of rows) {
    list.append(
      el(
        'button',
        {
          class: 'artifact-row',
          style: { paddingLeft: `${14 + row.depth * 18}px` },
          onclick: () => {
            if (row.isFolder) {
              if (session.expanded.has(row.path)) session.expanded.delete(row.path);
              else session.expanded.add(row.path);
              renderBody({ keepScroll: true });
            } else if (row.url) {
              chrome.tabs.create({ url: row.url });
            }
          },
        },
        icon(row.isFolder ? (row.expanded ? 'chevron-down' : 'chevron-right') : 'file', { size: 13 }),
        row.isFolder && icon('folder', { size: 13 }),
        el('span', { class: 'truncate', text: row.name }),
      ),
    );
  }
  body.append(list);
}

function paintFooter() {
  const foot = clear($('#viewer-foot'));
  foot.append(el('span', { text: `${session.lines.length} lines` }));
  if (session.error) foot.append(el('span', { class: 'spacer' }), el('span', { text: session.error }));
  else if (session.timer) foot.append(el('span', { class: 'spacer' }), el('span', { class: 'follow-on', text: 'Live - checking every 3s' }));
  else if (session.finished) foot.append(el('span', { class: 'spacer' }), el('span', { text: 'Job finished' }));
}

function scrollToBottom() {
  const body = $('#viewer-body');
  body.scrollTop = body.scrollHeight;
}

function downloadLog() {
  const { pipeline, counter, stage, job } = session.target;
  const blob = new Blob([session.lines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: `${pipeline}-${counter}-${stage}-${job}.log` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Log saved', { tone: 'ok', timeout: 1600 });
}
