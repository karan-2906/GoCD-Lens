/**
 * Setup and settings.
 *
 * This page collects a credential and hands it to the service worker; it never
 * reads one back. Once saved, the only thing it can learn about the stored
 * secret is the last four characters, which is enough to recognise it and not
 * enough to use it.
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
  confirmDialog,
} from "../common/ui.js";
import { originPattern } from "../lib/gocd.js";
import {
  DEFAULT_SETTINGS as DEFAULTS,
  backgroundPeriodMinutes,
} from "../lib/store.js";

let state = null;

init();

async function init() {
  await loadSprite();
  decorateIcons();

  state = await send("getState");
  applyTheme(state.settings.theme);
  paintPrivacy();
  paintSettings();
  paintLoadEstimate();
  paintNotificationPermission();
  paintConnection();
  wireConnection();
  wireSettings();
  wirePrivacy();

  if (new URLSearchParams(location.search).get("welcome")) {
    $("#welcome").hidden = false;
    $("#server-url").focus();
  }

  openRequestedSection();

  $("#open-dashboard").addEventListener("click", (event) => {
    event.preventDefault();
    chrome.tabs.create({
      url: chrome.runtime.getURL("src/dashboard/dashboard.html"),
    });
  });
}

/**
 * The dashboard links here with a section in the hash -- "why is my data
 * stale?" should land on the check that answers it, already running, rather
 * than at the top of a long page.
 */
function openRequestedSection() {
  const wanted = location.hash.replace("#", "");
  if (wanted !== "diagnostics") return;

  const card = $("#diagnostics-card");
  card.scrollIntoView({ behavior: "smooth", block: "start" });
  flash(card);
  withBusy($("#run-diagnostics"), diagnose);
}

function decorateIcons() {
  $("#toggle-token").append(icon("eye"));
}

// ------------------------------------------------------------- connection

function paintConnection() {
  const conn = state.connection;
  $("#disconnect").hidden = !conn;
  $("#save").textContent = conn ? "Save connection" : "Connect";
  if (!conn) return;

  $("#server-url").value = conn.serverUrl;
  const radio = $(`#auth-${conn.authMode}`);
  if (radio) radio.checked = true;
  if (conn.authMode === "basic") $("#username").value = conn.username || "";
  syncAuthFields();

  if (conn.secretHint) {
    $("#token-hint").textContent =
      conn.authMode === "token"
        ? `A token ending ${conn.secretHint.slice(-4)} is saved. Leave this blank to keep it.`
        : "";
  }

  if (!state.hasPermission) {
    showResult(
      "warn",
      "Your browser has not granted this extension access to that server yet. Press Connect to approve it.",
    );
  }
}

function syncAuthFields() {
  const mode = selectedAuthMode();
  $("#token-field").hidden = mode !== "token";
  $("#basic-fields").hidden = mode !== "basic";
}

function selectedAuthMode() {
  return (
    document.querySelector('input[name="auth"]:checked')?.value || "session"
  );
}

function wireConnection() {
  for (const radio of document.querySelectorAll('input[name="auth"]')) {
    radio.addEventListener("change", syncAuthFields);
  }

  $("#server-url").addEventListener("input", warnAboutUrl);
  $("#toggle-token").addEventListener("click", () =>
    toggleSecret("#token", "#toggle-token"),
  );

  $("#save").addEventListener("click", () => withBusy($("#save"), save));
  $("#test").addEventListener("click", () => withBusy($("#test"), test));
  $("#disconnect").addEventListener("click", disconnect);
  $("#run-diagnostics").addEventListener("click", () =>
    withBusy($("#run-diagnostics"), diagnose),
  );
}

function toggleSecret(inputSelector, buttonSelector) {
  const input = $(inputSelector);
  const button = $(buttonSelector);
  const showing = input.type === "text";
  input.type = showing ? "password" : "text";
  clear(button).append(icon(showing ? "eye" : "eye-off"));
}

function warnAboutUrl() {
  const raw = $("#server-url").value.trim();
  const host = $("#url-warning");
  clear(host);
  if (!raw) return;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return;
  }

  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);
  if (url.protocol === "http:" && !isLocal) {
    host.append(
      banner(
        "warn",
        "alert",
        "That is a plain http:// address. Your credential and every response travel unencrypted, and anything on the network can read them. Use https:// if your GoCD server offers it.",
      ),
    );
  } else if (url.protocol !== "https:" && url.protocol !== "http:") {
    host.append(
      banner("error", "alert", "That does not look like a web address."),
    );
  } else if (
    !/\/go\/?$/.test(url.pathname) &&
    url.pathname.replace(/\/+$/, "") === ""
  ) {
    host.append(
      banner(
        "info",
        "info",
        "Most GoCD servers live under a /go path. If nothing loads, try adding /go to the end.",
      ),
    );
  }
}

/** Collect the form into a Connection, keeping the saved secret when left blank. */
function readForm() {
  const serverUrl = $("#server-url").value.trim().replace(/\/+$/, "");
  if (!serverUrl) throw new Error("Enter your GoCD server URL first.");
  try {
    new URL(serverUrl);
  } catch {
    throw new Error(
      `"${serverUrl}" is not a web address. It should look like https://gocd.example.com/go`,
    );
  }

  const authMode = selectedAuthMode();
  const connection = { serverUrl, authMode };

  if (authMode === "token") {
    const token = $("#token").value.trim();
    if (
      !token &&
      !(state.connection?.authMode === "token" && state.connection?.hasSecret)
    ) {
      throw new Error(
        "Paste your GoCD access token, or switch to using your existing login.",
      );
    }
    if (token) connection.token = token;
    else connection.keepExistingSecret = true;
  } else if (authMode === "basic") {
    connection.username = $("#username").value.trim();
    const password = $("#password").value;
    if (!connection.username) throw new Error("Enter your GoCD username.");
    if (password) connection.password = password;
    else if (
      state.connection?.authMode === "basic" &&
      state.connection?.hasSecret
    ) {
      connection.keepExistingSecret = true;
    } else {
      throw new Error("Enter your GoCD password.");
    }
  }
  return connection;
}

/**
 * Chrome grants host access one origin at a time and only in response to a
 * click, which is why this runs here rather than in the service worker.
 */
async function ensurePermission(serverUrl) {
  // Chrome only honours this inside a user gesture, and an earlier `await`
  // spends it. So there is no `permissions.contains` pre-check here -- asking
  // for a permission already held resolves immediately without a prompt.
  const granted = await chrome.permissions.request({
    origins: [originPattern(serverUrl)],
  });
  if (!granted) {
    throw new Error(
      "Your browser needs your permission to let this extension talk to that server. Nothing else can be reached without it.",
    );
  }
  return true;
}

async function save() {
  clear($("#connection-result"));
  const connection = readForm();
  await ensurePermission(connection.serverUrl);

  const result = await send("saveConnection", { connection });
  state = await send("getState");
  paintConnection();

  showResult(
    "ok",
    result.user
      ? `Connected to GoCD ${result.version || ""} as ${result.user}.`.replace(
          "  ",
          " ",
        )
      : `Connected to GoCD ${result.version || ""}.`.trim(),
  );
  $("#token").value = "";
  $("#password").value = "";
  toast("Connected", { tone: "ok" });
}

async function test() {
  clear($("#connection-result"));
  const connection = readForm();
  if (connection.keepExistingSecret) {
    throw new Error(
      "Testing a saved secret is not possible from here - press Save to verify it.",
    );
  }
  await ensurePermission(connection.serverUrl);
  const result = await send("testConnection", { connection });
  showResult(
    "ok",
    `GoCD ${result.version || ""} answered: ${result.pipelines} pipelines across ${result.groups} groups. Nothing was saved.`,
  );
}

async function disconnect() {
  const confirmed = await confirmDialog({
    title: "Disconnect this server?",
    body: "The stored credential and the cached pipeline list are deleted from this machine. Your stars and settings are kept.",
    confirmLabel: "Disconnect",
    tone: "danger",
  });
  if (!confirmed) return;
  await send("disconnect");
  state = await send("getState");
  location.reload();
}

function showResult(tone, message) {
  const host = clear($("#connection-result"));
  host.append(
    banner(
      tone === "ok" ? "info" : tone,
      tone === "ok" ? "check" : "alert",
      message,
    ),
  );
}

function banner(tone, iconName, message) {
  return el(
    "div",
    { class: `banner banner-${tone}` },
    icon(iconName),
    el("span", { text: message }),
  );
}

// ------------------------------------------------------------ diagnostics

async function diagnose() {
  const host = clear($("#diagnostics"));
  host.append(el("p", { class: "muted small", text: "Checking..." }));

  const result = await send("diagnose");
  clear(host);
  if (!result.configured) {
    host.append(banner("info", "info", "Connect a server first."));
    return;
  }

  for (const probe of result.probes) {
    host.append(
      el(
        "div",
        { class: `probe ${probe.ok ? "ok" : "bad"}` },
        el("span", { class: "probe-dot" }, icon(probe.ok ? "check" : "x")),
        el("span", { class: "probe-name", text: probe.label }),
        el("span", { class: "probe-detail truncate", text: probe.detail }),
        el("span", { class: "probe-ms", text: `${probe.ms}ms` }),
      ),
    );
  }

  const api = result.probes.find((p) => p.id === "dashboard");
  const web = result.probes.find((p) => p.id === "webui");
  if (api?.ok && web && !web.ok) {
    host.append(
      banner(
        "info",
        "shield",
        "The GoCD web UI is not serving pages right now, but the API is answering normally. Your pipelines are fine - GoCD Lens reads them directly and is unaffected.",
      ),
    );
  } else if (!api?.ok) {
    host.append(
      banner(
        "error",
        "alert",
        "The API itself is not answering. Check your VPN, then the server URL and credential above. GoCD Lens will keep showing the last data it cached.",
      ),
    );
  }
}

// --------------------------------------------------------------- settings

/**
 * Set a dropdown from a stored value.
 *
 * Assigning a value no option carries leaves the control blank or showing
 * something that was never chosen, and the next change event then writes that
 * back as if the user had picked it. Falling back to the documented default is
 * both visible and correct.
 */
function selectValue(selector, value, fallback) {
  const select = $(selector);
  const wanted = String(value);
  const known = [...select.options].some((option) => option.value === wanted);
  select.value = known ? wanted : String(fallback);
}

function paintSettings() {
  const s = state.settings;
  selectValue("#poll", s.pollSeconds, DEFAULTS.pollSeconds);
  selectValue("#badge-source", s.badgeSource, DEFAULTS.badgeSource);
  selectValue("#theme", s.theme, DEFAULTS.theme);
  selectValue("#density", s.density, DEFAULTS.density);
  selectValue(
    "#background-minutes",
    s.backgroundMinutes,
    DEFAULTS.backgroundMinutes,
  );
  $("#notifications").checked = s.notifications;
  $("#notify-when-closed").checked = s.notifyWhenClosed;
  $("#notify-starred").checked = s.notifyStarred;
  $("#sound").checked = s.sound;
  paintNotificationDelay();
  syncNotifyControls();
}

function syncNotifyControls() {
  const on = $("#notifications").checked;
  for (const id of ["#notify-starred", "#sound", "#notify-when-closed"]) {
    $(id).disabled = !on;
  }
  // With chimes off there is nothing to preview, so the row of play buttons
  // comes away entirely rather than sitting there greyed out.
  const audible = on && $("#sound").checked;
  $("#sound-table").hidden = !audible;
}

function wireSettings() {
  const patch = (fn) => async () => {
    state.settings = await send("updateSettings", { patch: fn() });
    applyTheme(state.settings.theme);
    paintLoadEstimate();
    paintNotificationDelay();
    paintNotificationPermission();
    toast("Saved", { tone: "ok", timeout: 1400 });
  };

  $("#poll").addEventListener(
    "change",
    patch(() => ({ pollSeconds: Number($("#poll").value) })),
  );
  // It sits inside the checkbox's label, so a plain click would toggle the tick.
  $("#goto-background").addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    focusBackgroundInterval();
  });

  $("#background-minutes").addEventListener(
    "change",
    patch(() => ({
      backgroundMinutes: Number($("#background-minutes").value),
    })),
  );
  $("#notify-when-closed").addEventListener(
    "change",
    patch(() => ({ notifyWhenClosed: $("#notify-when-closed").checked })),
  );
  $("#badge-source").addEventListener(
    "change",
    patch(() => ({ badgeSource: $("#badge-source").value })),
  );
  $("#notifications").addEventListener("change", () => {
    syncNotifyControls();
    // The warning below this toggle only exists while notifications are on.
    patch(() => ({ notifications: $("#notifications").checked }))();
  });
  $("#notify-starred").addEventListener(
    "change",
    patch(() => ({ notifyStarred: $("#notify-starred").checked })),
  );
  $("#sound").addEventListener("change", () => {
    syncNotifyControls();
    patch(() => ({ sound: $("#sound").checked }))();
  });
  $("#preview-start").addEventListener("click", () => preview("start"));
  $("#preview-success").addEventListener("click", () => preview("success"));
  $("#preview-failure").addEventListener("click", () => preview("failure"));

  $("#theme").addEventListener(
    "change",
    patch(() => ({ theme: $("#theme").value })),
  );
  $("#density").addEventListener(
    "change",
    patch(() => ({ density: $("#density").value })),
  );
}

/**
 * What these settings actually cost the GoCD server, spelled out.
 *
 * A dashboard everyone leaves open is a dashboard that can quietly become a
 * load problem, so the arithmetic is on screen rather than left to be guessed
 * at. Watching pipelines is free: it is read out of the same dashboard payload
 * the badge already needs, not a request of its own.
 */
function paintLoadEstimate() {
  const host = clear($("#load-estimate"));
  const s = state.settings;

  const openTab = s.pollSeconds > 0 ? Math.round(3600 / s.pollSeconds) : 0;
  const minutes = backgroundPeriodMinutes(s);
  const background = minutes > 0 ? Math.round(60 / minutes) : 0;

  const lines = [
    openTab > 0
      ? `About ${openTab} requests an hour while a dashboard tab is open and visible.`
      : "No automatic requests while a tab is open - only when you press refresh.",
    background > 0
      ? `Up to ${background} an hour in the background, dropping to about ${Math.max(1, Math.round(background / 4))} once nothing has changed for a few minutes.`
      : "Nothing in the background - the badge and notifications only update while a tab is open.",
    "Extra tabs and the popup cost nothing: requests inside one interval share a single fetch.",
    "Unchanged data comes back as an empty 304, and picking a view narrows the payload to that view.",
    "Watching a pipeline adds no requests at all - it is read from the data already being fetched.",
  ];

  const list = el("ul", { class: "privacy-list" });
  list.append(
    ...lines.map((line) =>
      el(
        "li",
        {},
        icon("activity"),
        el("span", { class: "muted", text: line }),
      ),
    ),
  );
  host.append(
    el(
      "h3",
      { class: "subhead", style: { marginTop: "4px" } },
      "How this affects GoCD",
    ),
    list,
  );

  // Changing an interval changes one or two of these lines and leaves the rest
  // alone. Without pointing at what moved, the numbers just silently differ and
  // you have to re-read all five to find out what your change did.
  const changed = lines.filter(
    (line, at) =>
      previousCostLines[at] !== undefined && previousCostLines[at] !== line,
  );
  previousCostLines = lines;
  if (changed.length) {
    for (const item of list.children) {
      if (changed.includes(item.textContent.trim())) flash(item);
    }
  }
}

/** The cost lines as they last read, so a re-render can say which ones moved. */
let previousCostLines = [];

/**
 * Draw attention to something that just changed, once. A settings page that
 * silently rewrites a number a screen away from the control you touched leaves
 * you to spot the difference yourself.
 */
function flash(node) {
  node.classList.remove("flash");
  void node.offsetWidth; // restart the animation rather than ignoring a repeat
  node.classList.add("flash");
  node.addEventListener("animationend", () => node.classList.remove("flash"), {
    once: true,
  });
}

/**
 * How late an alert can be, and whether one can arrive at all.
 *
 * Notifications are not pushed: GoCD offers no such channel, so the extension
 * finds out at its next poll and not a moment sooner. Saying "you will be told
 * when it fails" without saying it can lag sets people up to distrust it the
 * first time an alert lands after they already knew.
 *
 * Both of these sit under the master switch, because with notifications off
 * neither is a question anyone is asking.
 */
function paintNotificationDelay() {
  const host = clear($("#notification-delay"));
  const s = state.settings;

  // Shown whether or not notifications are switched on: it describes how the
  // extension checks, which is true either way.
  const where = el("a", {
    href: "#how-often",
    text: "check interval",
    onclick: (event) => {
      event.preventDefault();
      // Flash the whole card, not just its heading: the thing being pointed at
      // is the controls inside it, and a lit-up title leaves you still hunting.
      const card = $("#how-often").closest(".card");
      card.scrollIntoView({ behavior: "smooth", block: "start" });
      flash(card);
    },
  });

  const lead =
    "Notifications are checked periodically and may be delayed by the configured ";
  const tail = ".";

  host.append(
    el(
      "div",
      { class: "banner banner-info" },
      icon("clock"),
      el("span", {}, lead, where, tail),
    ),
  );
}

/** Take the user to the control the warning is about, and leave the choice to them. */
function focusBackgroundInterval() {
  const select = $("#background-minutes");
  select.scrollIntoView({ behavior: "smooth", block: "center" });
  select.focus();
  flash(select.closest(".field") || select);
}

/**
 * Where the operating system keeps its own notification switch.
 *
 * There is no extension API for opening it -- Chrome cannot launch System
 * Settings, and the platform URL schemes it might hand off to can be refused,
 * ignored, or disabled by policy. A button that might do nothing is worse than
 * no button, so this is the click-path in words, for the platform you are
 * actually on.
 */
/**
 * Which browser this actually is.
 *
 * The operating system lists the app by name, so "Google Chrome" is simply
 * wrong instruction on Edge or Brave -- and this extension runs on all of them.
 * The internal settings scheme follows the same name.
 */
function browserIdentity() {
  const brands = navigator.userAgentData?.brands || [];
  const named = brands.find(
    (brand) =>
      !/not.*brand/i.test(brand.brand) && !/^chromium$/i.test(brand.brand),
  );

  const ua = navigator.userAgent;
  if (named?.brand === "Microsoft Edge" || /\bEdg\//.test(ua)) {
    return { name: "Microsoft Edge", scheme: "edge" };
  }
  if (named?.brand === "Brave" || navigator.brave)
    return { name: "Brave", scheme: "brave" };
  if (named?.brand === "Opera" || /\bOPR\//.test(ua))
    return { name: "Opera", scheme: "opera" };
  if (named?.brand === "Vivaldi") return { name: "Vivaldi", scheme: "vivaldi" };
  return { name: named?.brand || "Google Chrome", scheme: "chrome" };
}

function osNotificationPath() {
  const { name } = browserIdentity();
  const platform =
    navigator.userAgentData?.platform || navigator.platform || "";
  if (/mac/i.test(platform))
    return `System Settings \u2192 Notifications \u2192 ${name}`;
  if (/win/i.test(platform))
    return `Settings \u2192 System \u2192 Notifications \u2192 ${name}`;
  return `your desktop\u2019s notification settings, under ${name}`;
}

/**
 * Whether a notification will actually appear.
 *
 * Chrome's own setting is readable; the operating system's is not. On macOS,
 * System Settings can silence Chrome while Chrome still reports "granted", so
 * the only honest check is to send one and look.
 */
async function paintNotificationPermission() {
  const host = clear($("#notification-permission"));
  // Nothing here applies with notifications switched off, so it goes away with
  // them rather than sitting there answering a question nobody asked.
  if (!state.settings.notifications) return;

  const { level } = await send("notificationStatus");
  const path = osNotificationPath();
  const { scheme } = browserIdentity();

  const test = el(
    "span",
    { class: "banner-actions" },
    el("button", {
      class: "btn btn-sm",
      text: "Send a test notification",
      onclick: async () => {
        try {
          await send("testNotification");
          toast(`Sent. If nothing appeared, check ${path}.`, {
            tone: "info",
            timeout: 9000,
          });
        } catch (err) {
          toast(err.message, { tone: "error" });
        }
      },
    }),
  );

  if (level === "denied") {
    host.append(
      el(
        "div",
        { class: "banner banner-error" },
        icon("alert"),
        el("span", {
          text: `Browser notifications are blocked, so nothing will appear. Turn them back on at ${scheme}://settings/content/notifications, and check ${path} as well.`,
        }),
        test,
      ),
    );
    return;
  }

  host.append(
    el(
      "div",
      { class: "banner banner-info" },
      icon("info"),
      el("span", {
        text: `Browser notifications are enabled. Your system may still block notifications separately. Check ${path} if you're not receiving them.`,
      }),
      test,
    ),
  );
}

/**
 * Play one chime, and say why if nothing came out. A preview button that does
 * nothing and explains nothing is worse than no preview button.
 */
async function preview(name) {
  try {
    const result = await send("previewSound", { name });
    if (result && !result.ok) {
      toast(`Your browser would not play it: ${result.error}`, {
        tone: "warn",
        timeout: 7000,
      });
    }
  } catch (err) {
    toast(err.message, { tone: "error" });
  }
}

// ---------------------------------------------------------------- privacy

function paintPrivacy() {
  const facts = [
    [
      "Everything stays on this device.",
      "Your settings, starred pipelines, and cached pipeline data are stored locally in this browser profile. Browser sync is not used, so your data stays on this machine.",
    ],
    [
      "Only your GoCD server is contacted.",
      "The extension communicates only with the GoCD server you explicitly connect to. It does not access or modify the other websites you visit.",
    ],
    [
      "Your credentials stay off the page.",
      "GoCD credentials are stored in the extension's background worker and are never exposed to web pages. The dashboard only receives the pipeline data it needs.",
    ],
    [
      "No analytics or telemetry.",
      "The extension does not collect usage data or send analytics anywhere. Its scripts, styles, and icons are bundled with the extension\u2014nothing is loaded remotely.",
    ],
    [
      "Build output is always treated as text.",
      "Pipeline names, console logs, and other build output are rendered as text, so content returned by a build cannot execute as code.",
    ],
  ];

  const list = clear($("#privacy-list"));
  for (const [title, detail] of facts) {
    list.append(
      el(
        "li",
        {},
        icon("shield"),
        el(
          "span",
          {},
          el("strong", { text: title }),
          " ",
          el("span", { class: "muted", text: detail }),
        ),
      ),
    );
  }
}

function wirePrivacy() {
  $("#wipe").addEventListener("click", async () => {
    const confirmed = await confirmDialog({
      title: "Erase everything?",
      body: "Deletes the stored credential, the cached pipeline list, your stars and all settings from this machine. This cannot be undone.",
      confirmLabel: "Erase everything",
      tone: "danger",
    });
    if (!confirmed) return;
    await send("wipe");
    location.reload();
  });
}

// ----------------------------------------------------------------- plumbing

async function withBusy(button, fn) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Working...";
  try {
    await fn();
  } catch (err) {
    showResult("error", err.message);
    toast(err.message, { tone: "error", timeout: 6000 });
  } finally {
    button.disabled = false;
    // A successful save repaints this button with a new label; only put the
    // old one back if nothing did.
    if (button.textContent === "Working...") button.textContent = label;
  }
}
