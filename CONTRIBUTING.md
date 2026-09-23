# Contributing to GoCD Lens

Thanks for looking. This is a small project with strong opinions, and the fastest way to get a
change merged is to know which of those opinions are load-bearing.

---

## Raising an issue

Open one at **[github.com/karan-2906/GoCD-Lens/issues](https://github.com/karan-2906/GoCD-Lens/issues)**.
There are two templates; pick whichever fits and fill in what you can.

**For a bug**, the three things that actually speed up a fix:

1. **Your GoCD version** — `/go/api/version`, or the footer of the GoCD web UI.
2. **Which sign-in mode** you use: existing session, personal access token, or username and
   password. A surprising number of problems are one mode only.
3. **What you saw versus what you expected.** A screenshot of the extension beats a description.

**Never paste a token, a password, a cookie, or a full internal URL** into an issue. Redact the
host. If a problem cannot be explained without one of those, see [SECURITY.md](SECURITY.md)
instead — that goes to a private inbox.

**For a feature**, say what you were trying to do, not just what to build. Several things in this
project were deliberately removed once; [`CLAUDE.md`](CLAUDE.md) has a table of them and why. If
your idea is on that list, the _why_ is the part worth arguing with.

---

## Raising a pull request

```sh
git clone https://github.com/karan-2906/GoCD-Lens.git
cd GoCD-Lens
npm run hooks    # pre-commit runs the suite; see below for why that matters
npm test
```

There is **no build step and no dependencies**. The files in `src/` are the files that run. Load
the folder through `chrome://extensions` → Developer mode → Load unpacked, and press reload there
after editing.

Then:

1. **Branch off `master`.** `fix/badge-counts-twice`, `feat/filter-by-agent` — anything readable.
2. **Make the change, and keep it to one thing.** A PR that fixes a bug _and_ renames things is two
   reviews wearing one hat.
3. **`npm test` must pass.** The pre-commit hook runs it for you and refuses the commit otherwise.
   CI runs the same suite on the PR.
4. **Add a test when you fix a bug.** Not for style — because several bugs here have come back, and
   a test is the only thing that stops the third time.
5. **Open the PR.** The template asks how you verified it. "Tests pass" is not a verification of a
   UI change; say what you looked at.

Review is usually a day or two. Small PRs get looked at faster than large ones, which is the usual
tradeoff and not a hint to split something that genuinely belongs together.

---

## The rules a PR cannot break

These are enforced by [`tests/package-integrity.test.mjs`](tests/package-integrity.test.mjs), which
reads the actual files. They are not style preferences — each one is a promise made to users on the
store listing and the website.

| Rule                                                   | Why                                                                                                                                                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`chrome.storage.local` only**                        | `storage.sync` uploads to the user's Google account and copies to every machine they own. The extension promises it never does that.                                               |
| **No `innerHTML`, no `eval`, no `new Function`**       | Build logs and commit messages are the least trustworthy data in the product. `el()` in `common/ui.js` is the only way data reaches the screen, and it assigns with `textContent`. |
| **`host_permissions` stays empty**                     | A fresh install must be able to reach nothing. Access is requested one origin at a time, at Connect.                                                                               |
| **No content scripts, no remote assets, no analytics** | The user's GoCD server is the only host contacted. This is unconditional, and it is why the extension can be trusted with a credential.                                            |

One more that no test can catch: **pages never call GoCD**. They post a message to the service
worker, which owns the credential and makes the request. A bug in a rendering path therefore cannot
leak a token. Keep that seam.

---

## Style

Comments explain **why**, not what — especially where the code looks odd but is deliberate.
[`CLAUDE.md`](CLAUDE.md) is the long version: the GoCD API gotchas that cost real debugging, the
decisions and their reasons, and the things removed on purpose. It is worth skimming before a first
PR, and it is where a "why on earth is it written like this" usually gets answered.

User-facing text says "browser", not "Chrome" — this runs on Edge and Brave too.

---

## Things that need doing

Good first issues are labelled as such. Beyond those, two known gaps are written up in `CLAUDE.md`:
a watched pipeline outside the active view never notifies, and the `allowEmpty` query parameter's
spelling has never been confirmed against a live server.
