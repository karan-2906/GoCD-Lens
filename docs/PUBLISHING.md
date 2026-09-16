# Publishing GoCD Lens

Everything needed to get this extension off your laptop and onto other people's browsers: which
distribution route to pick, the exact text and images the Chrome Web Store asks for, and what its
reviewers will question about *this* extension in particular.

---

## 1. Pick a route first

The listing work below is only worth doing for the Web Store routes. Decide this before you start.

| Route | Who can install | Cost | Updates | Good for |
|---|---|---|---|---|
| **Web Store, Unlisted** ⭐ | Anyone with the link; not searchable | $5 once | Automatic | **A team.** Usually the least friction |
| Web Store, Private | Only members of one Google Workspace domain | $5 once | Automatic | An org that wants it locked to staff |
| Web Store, Public | Anyone, searchable | $5 once | Automatic | An open-source release |
| Enterprise policy | Whoever your MDM says | Free | Automatic, you host it | Managed fleets, no store at all |
| Load unpacked | Whoever repeats the steps by hand | Free | Manual, forever | You and one other person |

⭐ **Unlisted is the recommendation** for an internal tool. It gives you automatic updates and a
normal one-click install, without putting a GoCD dashboard in a public search index.

> The $5 is a one-off developer-account registration fee, not per extension and not annual.

---

## 2. Before you submit

```sh
npm test              # must be green -- this is what the pre-commit hook runs too
npm run screenshots   # only if the UI changed
npm run store         # the exact-size store assets
npm run package       # produces gocd-lens.zip
```

Then check, in order:

- [ ] **Bump `version` in `manifest.json`.** The store rejects a version it has already seen, and
      this is the single most common failed upload. `1.0.0` → `1.0.1`.
- [ ] `manifest.json` `name`, `description` and icons are what you want publicly visible.
- [ ] **The privacy policy is live at a public URL.** See step 5 — this blocks submission.
- [ ] Open `gocd-lens.zip` and confirm it contains `manifest.json`, `icons/`, `sounds/`, `src/`
      and nothing else — no `.git`, no `docs/`, no `node_modules`.
- [ ] Load the unpacked folder once in Chrome and connect it to a real GoCD server. Nothing in
      this repository has ever been run as an installed extension against a live server.

---

## 3. Route A — Chrome Web Store

### 3.1 Create the developer account

1. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
2. Sign in with the Google account that should own the extension. **Choose deliberately** — moving
   an item between accounts later is possible but tedious, and a personal account is a poor owner
   for something a team depends on.
3. Pay the one-time $5 registration fee.
4. Verify the contact email on the account. Google will not let you publish until you do.

> For **Private** visibility, this account must belong to the Google Workspace domain you want to
> restrict to. A personal Gmail account cannot publish privately to a company.

### 3.2 Upload

1. **Add new item** → drag in `gocd-lens.zip`.
2. The dashboard parses the manifest and creates a draft. Nothing is public yet; a draft can sit
   there indefinitely.

### 3.3 Store listing tab

Paste-ready copy. Everything here is already true of the extension — check it again if you change
what it does.

**Name** (45 characters max)

```
GoCD Lens
```

**Summary** (132 characters max — this is the one-liner in search results)

```
See your GoCD pipelines even when the GoCD web UI won't load. Reads the API directly. Nothing leaves your machine.
```

**Description** (16,000 characters max)

```
GoCD Lens reads your GoCD server's REST API and draws its own dashboard, so it keeps working when
the GoCD web interface does not.

WHAT IT DOES

• The pipeline list — every group and pipeline you can see, loaded in one request and cached to
  disk, so the tab paints instantly and stays readable when the network is gone. Colour-coded
  cards with a per-stage strip show you where a run broke without clicking into it.
• Fuzzy search — type "wabp" to find "web-app-build-prod", with the matched letters highlighted.
• Your GoCD personalized views, the same tabs as the web dashboard, plus Starred and Watching.
• One pipeline — full run history, each run's stages and jobs, manual-approval gates marked, and
  what the run was built from: repo, branch, commit, author and message, one click to the commit.
• Act on things — run, pause, resume, stop a running stage, and re-run chosen jobs. A stage of a
  dozen parallel end-to-end jobs is normal, and re-running all of them to retry one flaky job
  wastes agents, so the re-run button lists the jobs with the failed ones already ticked.
• Console logs — live tailing while the job runs, fetching only the new lines, with search,
  severity colouring, wrapping, download, and the artifact tree.
• Watch a pipeline and be told when a run starts and finishes — whether it passed and, if not,
  which stage went red — with an optional short chime.
• A toolbar badge that counts what is running, and turns red with a failure count when nothing is.
• An "is it GoCD, or is it me?" check that probes the API and the web UI separately and times
  both, so you can tell a broken dashboard from a broken pipeline.

BUILT FOR A BIG INSTANCE

This was written against a GoCD server with thousands of pipelines. Nothing it does costs a
request per pipeline: one endpoint does nearly all the work, unchanged data costs an empty 304,
a hidden tab does not poll at all, extra tabs share one cache, and watching a pipeline adds no
requests at all.

PRIVACY

• Everything stays on your machine, in this browser profile. chrome.storage.sync — which would
  upload to your Google account — is never used anywhere.
• No site access up front. The extension ships with an empty host_permissions list and asks for
  one origin, at the moment you press Connect.
• No content scripts. It cannot read, see or touch any page you browse.
• Your GoCD server is the only host it ever contacts. No analytics, no third parties, no remote
  code of any kind.
• Three ways to sign in, starting with the session you already have in this browser, which stores
  nothing at all.

Requires Chrome 116 or later. Works in Edge and Brave too. Not affiliated with the GoCD project
or ThoughtWorks.
```

**Category:** Developer Tools
**Language:** English

**Store icon:** `icons/icon128.png` (128×128, already the right size)

**Screenshots** — 1280×800, upload in this order. Generated by `npm run store`:

| File | What it shows |
|---|---|
| `docs/store/store-dashboard.png` | The pipeline list |
| `docs/store/store-pipeline.png` | One pipeline: history, stages, jobs, the commit |
| `docs/store/store-console.png` | A job's console log |
| `docs/store/store-dark.png` | Dark mode |
| `docs/store/store-settings.png` | Settings and the three sign-in modes |

**Small promo tile** (440×280): `docs/store/promo-small.png`
**Marquee promo tile** (1400×560, optional): `docs/store/promo-marquee.png`

> The promo tiles are only *required* if you want the item eligible for store promotion, but an
> item with no tile looks unfinished next to one that has one.

### 3.4 Privacy tab — this is where a submission actually gets held up

**Single purpose** (one sentence, and reviewers hold you to it):

```
GoCD Lens displays the state of the user's GoCD continuous-delivery pipelines, read from that
server's REST API, and lets the user act on those pipelines.
```

**Permission justifications** — one per permission the manifest declares. Paste these:

| Permission | Justification |
|---|---|
| `storage` | Stores the GoCD server address the user entered, their display and notification preferences, the names of pipelines they starred or chose to watch, and the most recent dashboard response so the tab paints instantly and remains readable when the server is unreachable. Uses `chrome.storage.local` only; `chrome.storage.sync` is never used. |
| `alarms` | Schedules the optional periodic check that keeps the toolbar badge current when no dashboard tab is open. It is off by default and the user turns it on in settings. |
| `notifications` | Notifies the user when a pipeline they explicitly chose to watch starts or finishes, and when a starred pipeline turns red. Notifications are only ever raised for pipelines the user picked. |
| `offscreen` | A Manifest V3 service worker has no DOM and therefore cannot play audio. The offscreen document exists solely to play the short bundled notification chime that accompanies a watched pipeline finishing. |
| **Host permissions** `https://*/*`, `http://*/*` | The extension contacts exactly one host: the GoCD server the user names during setup. That address cannot be declared in advance because GoCD is self-hosted software — every user's server is at a different internal hostname. `host_permissions` in the manifest is therefore **empty**, and access is requested for a single origin with `chrome.permissions.request` at the moment the user presses Connect. No other origin is ever contacted. `http` is offered because many internal GoCD servers are not behind TLS; the setup page warns the user when it is used. |

**Remote code:** answer **No**. Every script, style, icon and sound ships inside the package, and
the Content Security Policy in the manifest blocks inline and remote script.

**Data usage** — declare honestly. The form asks which categories the item handles:

- ✅ **Authentication information** — if the user chooses token or password sign-in, that secret is
  stored locally and sent to their own GoCD server. Declare it. In the "how is it used" box:
  *"Stored locally in chrome.storage.local and sent only to the GoCD server the user configured,
  as the Authorization header on their own API requests. It is never transmitted to the developer
  or to any third party."*
- ❌ Everything else — personally identifiable information, health, financial, personal
  communications, location, web history, user activity, website content. None of these are
  collected; there are no content scripts and no tracking of any kind.

Then tick all three certifications; each is true here:

- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL** — required, and it must be publicly reachable without a login.

Use the landing page's own copy: **`https://gocd-lens.vercel.app/privacy`** (substitute your real
domain). It is [`site/privacy.html`](../site/privacy.html), it deploys with the site, and it does
not depend on the source repository being public.

> The repository is currently **private**, so a `github.com/.../blob/...` URL returns 404 to a
> reviewer and would get the submission rejected. Deploy the site first, confirm the `/privacy`
> URL opens in a private browser window, and only then submit.

[`PRIVACY.md`](PRIVACY.md) holds the same text for people reading the repository. **Both copies
have a contact-email placeholder — fill in both before publishing.**

### 3.5 Distribution tab

- **Visibility:** Unlisted (or Private, and then pick the domain).
- **Distribution regions:** all, unless you have a reason.
- There is no payment or in-app purchase to configure.

### 3.6 Submit

Press **Submit for review**. Then:

- Expect **a few days**. Extensions that ask for broad host permissions are reviewed by hand and
  take longer than trivial ones. Unlisted items are reviewed just like public ones.
- You cannot edit a submission while it is in review; you can only cancel and resubmit, which puts
  you back in the queue.
- Rejections arrive by email with a policy code. Fix and resubmit — a rejection is not a strike.

### 3.7 After it is approved

Your install link looks like:

```
https://chromewebstore.google.com/detail/gocd-lens/<32-character-extension-id>
```

The extension ID is on the item's page in the dashboard. Send that link to the team; unlisted
items install exactly like public ones for anyone holding it.

### 3.8 Shipping an update

1. Bump `version` in `manifest.json`.
2. `npm test && npm run package`
3. Dashboard → your item → **Package** → upload the new zip → submit.

Installed browsers pick it up within a few hours on their own. Updates go through review too, but
a small update to an established item is usually quicker than the first one.

---

## 4. Route B — enterprise policy, no store at all

Right when a fleet is already managed and you would rather not involve Google.

**A stable extension ID is the whole game here.** Off-store installs are keyed by ID, and the ID is
derived from the packaging key — so generate the key once and keep it.

```sh
# Generate a key and derive the ID from it. Keep private.pem somewhere safe and
# out of the repository; .gitignore already excludes *.pem.
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -outform DER -out private.der
openssl rsa -in private.der -inform DER -pubout -outform DER 2>/dev/null \
  | openssl base64 -A                      # -> paste as manifest "key"
```

Then:

1. Add that base64 string as a top-level `"key"` in `manifest.json`, and an
   `"update_url": "https://internal.example.com/gocd-lens/updates.xml"`.
2. Pack a `.crx` (`chrome://extensions` → **Pack extension**, pointing at your `.pem`), and host
   the `.crx` plus an `updates.xml` on an internal HTTPS server:

   ```xml
   <?xml version='1.0' encoding='UTF-8'?>
   <gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
     <app appid='YOUR_EXTENSION_ID'>
       <updatecheck codebase='https://internal.example.com/gocd-lens/gocd-lens-1.0.0.crx'
                    version='1.0.0' />
     </app>
   </gupdate>
   ```

3. Push the policy. `ExtensionInstallForcelist` with the value
   `YOUR_EXTENSION_ID;https://internal.example.com/gocd-lens/updates.xml` — via registry on
   Windows, a configuration profile on macOS, or your MDM's Chrome policy pane.

To update, bump the version in the manifest *and* in `updates.xml`, and replace the `.crx`.

> **This route only works on managed browsers.** Chrome refuses off-store `.crx` installs on an
> unmanaged profile, so an ordinary laptop with no MDM cannot use it.

---

## 5. Route C — load unpacked

Already documented in the [README](../README.md#install). Fine for you and a colleague, painful
for a team: every person repeats four steps, and every update is manual.

---

## 6. What reviewers will ask about, here specifically

**The broad optional host permission.** `optional_host_permissions: ["https://*/*", "http://*/*"]`
is the one thing in this manifest that draws attention. It is a legitimate and common pattern for
"the user brings their own self-hosted server", and the justification in §3.4 is the argument.
Three things help it land:

- `host_permissions` is empty, so a fresh install can reach nothing. Say that first.
- The extension has no content scripts, which is what the broad pattern usually gets abused for.
- If a reviewer pushes back anyway, you can narrow the optional pattern to your organisation's
  domain — `https://*.yourcompany.com/*` — which costs you the ability to point the extension at
  any other server, but removes the objection entirely.

**`http://` access.** Justify it once: internal CI servers frequently are not on TLS, and the setup
page warns the user when the URL is `http`. If you would rather not argue it, drop `http://*/*`
from `optional_host_permissions` and require HTTPS.

**"Does it use remote code?"** No — and the CSP in the manifest is the evidence.

**Single purpose.** One extension, one job. Do not add anything unrelated to GoCD to this package.

---

## 7. Microsoft Edge, optionally

Edge and Brave install Chrome Web Store extensions directly, so the store listing already covers
them. If you want a first-class Edge listing as well, the
[Edge Add-ons](https://partner.microsoft.com/dashboard/microsoftedge) programme takes the same zip
and the same assets, and charges no registration fee. It is a separate submission and a separate
review.
