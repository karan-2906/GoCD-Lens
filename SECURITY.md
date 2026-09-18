# Security Policy

GoCD Lens handles a credential to your CI server. If you have found something that puts that at
risk, please report it privately rather than opening an issue.

## Reporting a vulnerability

**Email: karangandhi486@gmail.com** — put "GoCD Lens security" in the subject.

Or use GitHub's private route: **Security → Report a vulnerability** on the repository, which opens
a draft advisory only the maintainer can see.

Please include what you can:

- What an attacker can do, and what they need first (a malicious GoCD server? a hostile build log?
  another extension? local file access?)
- The steps to reproduce it
- The version, from `chrome://extensions` or `manifest.json`

**Do not open a public issue, and do not put a working exploit in one.** There is no bounty — this
is a side project — but you will be credited in the release notes unless you would rather not be.

You can expect a first reply within a week. If a fix is needed it ships as a patch release to the
Chrome Web Store, which updates installed browsers automatically within a few hours.

## What is in scope

The extension itself: the service worker, the pages, the storage layer, the manifest and its
permissions. Particularly interesting:

- Anything that gets the stored token or password out of the background worker
- Anything that makes the extension contact a host other than the one the user configured
- Anything that turns server-supplied text — a build log, a commit message, a pipeline name, a
  material description — into markup or code
- Anything that writes to `chrome.storage.sync`

## What is not in scope

- **Your own GoCD server.** Report those to your GoCD administrators, or to the GoCD project.
- **The credential not being encrypted at rest.** This is known, documented, and unavoidable:
  `chrome.storage.local` is not encrypted, and browser extensions have no access to the operating
  system keychain. It is why "use my existing GoCD login", which stores nothing, is the default.
  See the [privacy policy](https://go-cd-lens.vercel.app/privacy).
- **Anyone with local access to an unlocked machine.** An extension cannot defend against the
  person sitting at the computer.
- The marketing website, beyond it being a static page with no scripts.

## Supported versions

The latest release on the Chrome Web Store. There are no long-term support branches.
