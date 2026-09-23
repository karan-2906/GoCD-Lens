# GoCD Lens — Privacy Policy

_Last updated: 17 September 2026_

GoCD Lens is a browser extension that shows you your own GoCD pipelines. It is built so that
there is nothing to collect: the extension has no server, no account, and no third parties.

**The developer of GoCD Lens receives no data from you of any kind.** There is no analytics, no
telemetry, no crash reporting and no "anonymous usage statistics".

---

## What the extension stores, and where

Everything below is stored in `chrome.storage.local`, which is a file inside your own browser
profile on your own machine. It is never uploaded anywhere.

| What                                                                                    | Why it is kept                                                                        | When it is written         |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------- |
| Your GoCD server URL                                                                    | It is the one address the extension is allowed to contact                             | When you press Connect     |
| Your sign-in choice                                                                     | To know whether to use your existing session, a token, or basic auth                  | When you press Connect     |
| A personal access token or password, **only if you choose one of those modes**          | It is sent to your GoCD server to authenticate your own requests                      | When you press Connect     |
| Display settings — refresh interval, theme, density, notification and badge preferences | To keep the extension the way you set it                                              | When you change a setting  |
| The names of pipelines you star or watch                                                | To pin them and to notify you about them                                              | When you star or watch one |
| The most recent dashboard response from your server                                     | So the tab paints instantly, and still shows something when the server or VPN is down | On every refresh           |

**`chrome.storage.sync` is never used anywhere in this extension.** That is the storage area that
would copy data to your Google account and to every other machine you are signed in on. A test in
the source tree fails the build if any code ever references it.

### The credential in particular

If you pick **Use my existing GoCD login**, nothing is stored at all — the extension rides the
session cookie your browser already has.

If you pick a token or a password, it is stored locally and used for one purpose: the
`Authorization` header on requests to the GoCD server you named. It is held only by the extension's
background service worker. The extension's own pages — the dashboard, the popup, the settings
page — never receive it; the settings page can learn the last four characters of what is stored so
you can tell two tokens apart, and nothing more.

**It is not encrypted on disk.** `chrome.storage.local` is a file in your browser profile. No
website can read it -- web pages have no access to extension storage at all -- and no other
extension can read it either, because each extension gets its own isolated area. But it is not
encrypted, so anything that can read your browser profile as your operating-system user can read
the credential: malware running as you, another person at an unlocked machine, or an unencrypted
backup. Browser extensions have no access to the operating system keychain, so there is no safer
place to put it.

That is why **Use my existing GoCD login** is the default and the recommended mode: it stores
nothing, and rides a session cookie that Chrome does encrypt at rest. If you do store a
credential, prefer a personal access token over your password -- a token can be revoked on its
own.

---

## What the extension sends, and to whom

**The only host GoCD Lens ever contacts is the GoCD server you name.** No exceptions, and nothing
is relayed through any intermediary.

Requests go to that server's REST API and its artifact and console-log endpoints, and they carry
whatever credential you configured. This is the same traffic your browser would make if you used
GoCD's own web interface.

The extension loads no remote code. Every script, stylesheet, icon and sound ships inside the
package, and its Content Security Policy blocks inline and remote script. Nothing is fetched from
a CDN.

---

## Permissions, and why each one exists

| Permission      | What it is for                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `storage`       | The local storage described above                                                                                                   |
| `alarms`        | The optional background check that keeps the toolbar badge current when no dashboard tab is open. It ships **off**                  |
| `notifications` | Telling you when a pipeline you explicitly chose to watch starts or finishes, or when a starred pipeline turns red                  |
| `offscreen`     | A Manifest V3 service worker has no DOM and cannot play a sound. The offscreen document exists only to play the short bundled chime |
| Host access     | Requested **one origin at a time**, at the moment you press Connect. The extension ships with no site access at all                 |

GoCD Lens has **no content scripts**, so it cannot read, alter or observe any web page you visit.
It has no `tabs`, `cookies`, `webRequest`, `history` or `scripting` permission.

---

## Deleting your data

Open the extension's settings page and press **Erase everything**. That clears the connection, any
stored credential, your settings, your stars and watches, and the cached pipeline list.

Removing the extension from your browser also removes everything it stored.

---

## Children

GoCD Lens is a developer tool for continuous-delivery servers. It is not directed at children and
collects nothing from anyone.

---

## Changes to this policy

Any change will be published in this file in the extension's source repository, with the date at
the top updated.

---

## Contact

**Contact:** [karangandhi486@gmail.com](mailto:karangandhi486@gmail.com)

**Source code:** every claim on this page can be checked against the source, and
`tests/package-integrity.test.mjs` enforces the important ones against the actual files.
