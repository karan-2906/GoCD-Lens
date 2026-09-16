/**
 * The audio half of the notifications.
 *
 * A Manifest V3 service worker has no DOM and so cannot play a sound at all.
 * This invisible page is Chrome's supported way round that. It holds no data,
 * makes no network requests, and only ever plays a file that ships inside the
 * extension.
 */

/** Every chime that ships, by the name the service worker asks for. */
const SOUNDS = {
  start: 'sounds/start.wav',
  success: 'sounds/success.wav',
  failure: 'sounds/failure.wav',
};

// Kept so a burst of finishing pipelines does not re-read the files each time.
const cache = new Map();

async function play(name) {
  const path = SOUNDS[name];
  if (!path) return { ok: false, error: `no sound called ${name}` };

  let audio = cache.get(name);
  if (!audio) {
    audio = new Audio(chrome.runtime.getURL(path));
    audio.preload = 'auto';
    cache.set(name, audio);
  }

  // Played at the level baked into the file, which is deliberately quiet.
  audio.currentTime = 0;

  try {
    await audio.play();
    return { ok: true };
  } catch (err) {
    // Chrome's autoplay policy can still refuse. Report it rather than
    // swallowing it, so a preview button can say why nothing happened instead
    // of looking broken.
    return { ok: false, error: err?.message || String(err) };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Every extension context receives every runtime message, so ignore the ones
  // addressed to the service worker rather than answering them.
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.target !== 'offscreen') return false;

  if (message.type === 'playSound') {
    play(message.payload?.name).then(sendResponse);
    // Answering matters beyond politeness: it is how the worker tells "played"
    // apart from "this page was not listening yet", which is the difference
    // between a working chime and a silent one.
    return true;
  }

  sendResponse({ ok: false, error: `unknown request ${message.type}` });
  return false;
});
