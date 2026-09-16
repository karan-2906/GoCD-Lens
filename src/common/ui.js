/**
 * Small DOM and messaging helpers shared by the dashboard, popup and setup page.
 *
 * `el()` is the only way this extension puts data on screen, and it assigns
 * strings with `textContent`. Nothing in here ever touches `innerHTML`, which
 * is what keeps a build log, a commit message or a pipeline name from being
 * able to run as markup. Icons come from a bundled `<symbol>` sprite, so even
 * they are not assembled from strings at runtime.
 */

import { stageStatus } from '../lib/status.js';

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') throw new Error('el() does not accept raw HTML by design');
    else if (key in node && key !== 'list') node[key] = value;
    else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** An icon from the page's sprite sheet. */
export function icon(name, { size = 16, class: className = '' } = {}) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `icon ${className}`.trim());
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

/**
 * Icons live in one bundled SVG file rather than being pasted into each page.
 * It is fetched from this extension's own package and parsed with DOMParser --
 * no innerHTML, and nothing remote is ever loaded.
 */
export async function loadSprite() {
  const response = await fetch(chrome.runtime.getURL('src/common/sprite.svg'));
  const doc = new DOMParser().parseFromString(await response.text(), 'image/svg+xml');
  document.body.prepend(document.importNode(doc.documentElement, true));
}

/**
 * One segment per stage, in pipeline order -- the shape of a run at a glance.
 *
 * Shared rather than duplicated: the dashboard card and the popup row show the
 * same thing, and two copies would drift the moment a status was added.
 */
export function stageStrip(stages, { compact = false } = {}) {
  const strip = el('div', { class: `stage-strip${compact ? ' compact' : ''}` });
  if (!stages || stages.length === 0) {
    strip.append(el('div', { class: 'stage-seg' }));
    return strip;
  }
  for (const stage of stages) {
    const status = stageStatus(stage);
    strip.append(
      el('div', {
        class: `stage-seg s-${status}`,
        title: `${stage.name}: ${status === 'Unknown' ? 'not run' : status}`,
      }),
    );
  }
  return strip;
}

/**
 * Give every clipped `.truncate` its full text as a tooltip -- and only those.
 *
 * A `title` on everything is noise: it pops up over text you can already read.
 * The only way to know is to measure after layout, so this runs once per render
 * and compares scroll width against client width. Titles it adds are marked, so
 * a deliberate one set at build time is never clobbered or removed.
 */
export function applyOverflowTitles(root = document) {
  for (const node of root.querySelectorAll('.truncate')) {
    const clipped = node.scrollWidth > node.clientWidth + 1;

    if (clipped && !node.title) {
      node.title = node.textContent.trim();
      node.dataset.autoTitle = '1';
    } else if (!clipped && node.dataset.autoTitle) {
      node.removeAttribute('title');
      delete node.dataset.autoTitle;
    }
  }
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// ------------------------------------------------------------------ backend

/**
 * Ask the service worker to do something. It owns the credential and the
 * network; this page only ever handles the answer.
 */
export async function send(type, payload = {}) {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type, payload });
  } catch (err) {
    throw new Error(`The extension's background worker is not responding (${err.message}).`);
  }
  if (!response) throw new Error('No response from the background worker.');
  if (!response.ok) {
    const error = new Error(response.error || 'Something went wrong.');
    error.kind = response.kind;
    error.status = response.status;
    throw error;
  }
  return response.data;
}

// -------------------------------------------------------------------- theme

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
}

// ------------------------------------------------------------------ toasts

let toastHost = null;

export function toast(message, { tone = 'info', timeout = 4500 } = {}) {
  if (!toastHost) {
    toastHost = el('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const node = el('div', { class: `toast toast-${tone}` }, el('span', { text: message }));
  toastHost.append(node);
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 250);
  }, timeout);
  return node;
}

// ------------------------------------------------------------------ dialogs

/**
 * A modal that returns a promise. Used for every action that changes something
 * on the server, so nothing destructive happens on a single stray click.
 */
export function confirmDialog({
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'primary',
  extraAction = null,
}) {
  return new Promise((resolve) => {
    const dialog = el('dialog', { class: 'modal' });
    const close = (value) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };

    dialog.append(
      el(
        'form',
        { method: 'dialog', class: 'modal-card', onsubmit: (e) => e.preventDefault() },
        el('h2', { class: 'modal-title', text: title }),
        typeof body === 'string' ? el('p', { class: 'modal-body', text: body }) : body,
        el(
          'div',
          { class: 'modal-actions' },
          el('button', { type: 'button', class: 'btn btn-ghost', text: cancelLabel, onclick: () => close(null) }),
          extraAction &&
            el('button', {
              type: 'button',
              class: 'btn btn-ghost',
              text: extraAction.label,
              onclick: () => close(extraAction.value),
            }),
          el('button', {
            type: 'button',
            class: `btn btn-${tone}`,
            text: confirmLabel,
            onclick: () => close(true),
          }),
        ),
      ),
    );
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      close(null);
    });
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector('.btn-' + tone)?.focus();
  });
}

/** Highlight the characters a fuzzy search matched, without building markup. */
export function highlighted(text, positions) {
  if (!positions || positions.length === 0) return document.createTextNode(text);
  const fragment = document.createDocumentFragment();
  const hits = new Set(positions);
  let run = '';
  let runIsHit = false;
  const flush = () => {
    if (!run) return;
    fragment.append(runIsHit ? el('mark', { text: run }) : document.createTextNode(run));
    run = '';
  };
  for (let i = 0; i < text.length; i += 1) {
    const isHit = hits.has(i);
    if (isHit !== runIsHit) {
      flush();
      runIsHit = isHit;
    }
    run += text[i];
  }
  flush();
  return fragment;
}

export function copyToClipboard(text) {
  return navigator.clipboard.writeText(text).then(
    () => toast('Copied', { tone: 'ok', timeout: 1600 }),
    () => toast('Could not copy to the clipboard', { tone: 'warn' }),
  );
}

export function openTab(url) {
  chrome.tabs.create({ url });
}

/** Human wording for the errors a user can actually do something about. */
export function explain(error) {
  switch (error?.kind) {
    case 'config':
      return 'No GoCD server is set up yet. Open Settings to connect one.';
    case 'auth':
      return `${error.message} Open Settings and reconnect.`;
    case 'network':
      return `${error.message}`;
    case 'timeout':
      return 'GoCD took too long to answer. It may be restarting -- the data on screen is the last good copy.';
    default:
      return error?.message || 'Something went wrong.';
  }
}
