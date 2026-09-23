/**
 * Every byte this extension keeps lives in `chrome.storage.local`, which is a
 * file inside this Chrome profile on this machine.
 *
 * `chrome.storage.sync` is deliberately never used anywhere in this codebase:
 * it would upload its contents to Google's servers and fan them out to every
 * machine signed into the same Chrome profile. A GoCD access token must not
 * travel like that. If you are auditing this extension, grep for
 * `storage.sync` -- there are no hits.
 */

const K = {
  connection: "connection",
  settings: "settings",
  favorites: "favorites",
  watched: "watchedPipelines",
  cache: "dashboardCache",
  seen: "lastSeenStatus",
  recent: "recentPipelines",
  expanded: "expandedGroups",
  views: "viewDefinitions",
  popupSearch: "popupSearch",
};

export const DEFAULT_SETTINGS = {
  /**
   * How often an open, visible dashboard tab re-checks. 0 means only on demand.
   *
   * Ten seconds, because a tab you are looking at should feel live. That is
   * roughly 360 requests an hour, which is more often than GoCD's own dashboard
   * polls -- but each is a single view-scoped call against that dashboard's
   * pair, almost all of them empty 304s, and a tab you are not looking at stops
   * entirely. Anyone who wants it cheaper has five slower options in Settings,
   * with the arithmetic shown.
   */
  pollSeconds: 10,
  /**
   * Whether a background check is allowed to raise a notification. Off by
   * default: being interrupted with nothing open deserves an explicit yes.
   * Whether to check at all is `backgroundMinutes`.
   */
  notifyWhenClosed: false,
  /**
   * How often to check when nothing is open, in minutes. 0 is never.
   *
   * Its own setting rather than something derived from `pollSeconds`: a tab you
   * are watching wants to feel live, but an unattended check across a whole
   * team is real load on the server for very little. Off by default for the
   * same reason unattended notifying is -- traffic with nobody watching should
   * be asked for.
   */
  backgroundMinutes: 0,
  /**
   * The user's chosen GoCD personalized view, by name. `null` means every
   * pipeline they can see -- which is a real choice, not "unset", so the
   * refresh path has to tell it apart from "leave this alone".
   */
  activeView: null,
  notifications: true,
  /**
   * A lighter alert for starred pipelines, which are not the same set as the
   * watched ones: red on the way down, green on the way back, and nothing in
   * between. One switch rather than a scope and a direction, because "which
   * pipelines" is answered by what you starred and both directions of a
   * transition are worth the same amount.
   */
  notifyStarred: true,
  /**
   * What the toolbar badge counts: 'view' (whatever is open), 'watched', or
   * 'starred'.
   */
  badgeSource: "view",
  /**
   * A chime alongside a watched pipeline's start and finish notifications.
   *
   * There is no volume setting: the files are synthesised quiet on purpose
   * (about -13 dBFS), and the machine already has a volume control that works
   * for everything rather than just this.
   */
  sound: true,
  theme: "system",
  density: "comfortable",
  /** How pipelines are ordered inside a group. See SORTS in state.js. */
  sort: "config",
};

/**
 * How often to wake the background worker, in minutes. Zero means never.
 *
 * Governed by the interval alone, not by whether notifications are wanted: a
 * background check also keeps the toolbar badge current, which is worth having
 * on its own. Whether those checks are allowed to interrupt you is a separate
 * question, answered by `notifyWhenClosed`.
 */
export function backgroundPeriodMinutes(settings) {
  return settings?.backgroundMinutes || 0;
}

/**
 * @typedef {object} Connection
 * @property {string} serverUrl   e.g. https://gocd.example.com/go
 * @property {'session'|'token'|'basic'} authMode
 * @property {string} [token]
 * @property {string} [username]
 * @property {string} [password]
 */

async function get(key, fallback) {
  const out = await chrome.storage.local.get(key);
  return key in out && out[key] != null ? out[key] : fallback;
}

async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

export async function getConnection() {
  return get(K.connection, null);
}

export async function setConnection(conn) {
  await set(K.connection, conn);
}

/**
 * What a UI page is allowed to know about the connection: the server it points
 * at and how it authenticates, never the secret itself. Pages render this; the
 * token stays in the service worker and in storage.
 */
export function redactConnection(conn) {
  if (!conn) return null;
  return {
    serverUrl: conn.serverUrl,
    authMode: conn.authMode,
    username: conn.authMode === "basic" ? conn.username : undefined,
    hasSecret: Boolean(conn.token || conn.password),
    secretHint: secretHint(conn),
  };
}

function secretHint(conn) {
  const secret = conn.authMode === "basic" ? conn.password : conn.token;
  if (!secret) return null;
  // Enough to tell two tokens apart, not enough to be worth stealing.
  return `${"•".repeat(8)}${secret.slice(-4)}`;
}

export async function clearConnection() {
  await chrome.storage.local.remove([K.connection, K.cache, K.seen]);
}

export async function getSettings() {
  const stored = await get(K.settings, {});
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await set(K.settings, next);
  return next;
}

export async function getFavorites() {
  return get(K.favorites, []);
}

export async function toggleFavorite(name) {
  const favorites = await getFavorites();
  const idx = favorites.indexOf(name);
  if (idx === -1) favorites.push(name);
  else favorites.splice(idx, 1);
  await set(K.favorites, favorites);
  return favorites;
}

/**
 * The last good dashboard payload, so opening the extension paints instantly
 * and stays readable when the network (or the server) is gone.
 */
/**
 * Pipelines the user asked to be told about: these notify when a run starts and
 * again when it finishes, pass or fail. Separate from favourites, which only
 * pin a pipeline to the top of the list -- wanting something in easy reach and
 * wanting to be interrupted by it are different wishes.
 */
export async function getWatched() {
  return get(K.watched, []);
}

export async function toggleWatched(name) {
  const watched = await getWatched();
  const at = watched.indexOf(name);
  if (at === -1) watched.push(name);
  else watched.splice(at, 1);
  await set(K.watched, watched);
  return watched;
}

export async function getCache() {
  return get(K.cache, null);
}

export async function setCache(payload) {
  await set(K.cache, payload);
}

export async function getSeenStatus() {
  return get(K.seen, {});
}

export async function setSeenStatus(map) {
  await set(K.seen, map);
}

/**
 * Groups the user has folded shut. A server with a dozen pipeline groups is
 * unusable if it re-expands every one of them on each visit.
 */
/**
 * The user's GoCD personalized views, kept so the active one can be enforced
 * locally rather than trusted to the server's query parameter.
 */
export async function getViewDefinitions() {
  return get(K.views, []);
}

export async function setViewDefinitions(filters) {
  await set(K.views, filters || []);
}

/**
 * Groups the user has opened.
 *
 * Stored the way round it is because *shut* is the resting state: a server with
 * a dozen pipeline groups, several holding hundreds of pipelines, is a wall of
 * cards if every one is open on arrival. Remembering what was opened also means
 * a new group appearing on the server stays quietly folded rather than
 * unfolding itself into your list.
 */
export async function getExpandedGroups() {
  return get(K.expanded, []);
}

export async function setExpandedGroups(names) {
  await set(K.expanded, [...new Set(names)]);
  return getExpandedGroups();
}

/**
 * What was typed into the popup's search box, and when.
 *
 * The popup is a fresh document every time it opens, so a click anywhere else
 * on the page throws away what you typed -- which is a bad trade in a box whose
 * whole job is finding one pipeline among thousands, several keystrokes at a
 * time.
 *
 * It expires, because the popup's first duty is answering "is anything red?"
 * and a filter left over from yesterday answers it about one pipeline while
 * looking like it answered it about all of them. Coming straight back is
 * continuing; opening it tomorrow is a new question.
 */
export const POPUP_SEARCH_TTL_MS = 5 * 60 * 1000;

export async function getPopupSearch() {
  const saved = await get(K.popupSearch, null);
  if (!saved?.query) return "";
  return Date.now() - (saved.at || 0) < POPUP_SEARCH_TTL_MS ? saved.query : "";
}

export async function setPopupSearch(query) {
  if (!query) return set(K.popupSearch, null);
  return set(K.popupSearch, { query, at: Date.now() });
}

export async function getRecent() {
  return get(K.recent, []);
}

export async function pushRecent(name) {
  const recent = (await getRecent()).filter((n) => n !== name);
  recent.unshift(name);
  await set(K.recent, recent.slice(0, 12));
}

export async function wipeEverything() {
  await chrome.storage.local.clear();
}
