## What this changes

<!-- One or two sentences. If it closes an issue, say "Closes #123". -->

## Why

<!-- The reasoning, not the diff. This is the part that ends up in a comment and saves the next
     person an afternoon. -->

## How you verified it

<!-- "Tests pass" is not a verification of a UI change. Say what you actually looked at: loaded it
     unpacked against a real GoCD server, checked the popup at 400px, watched a pipeline finish. -->

## Checklist

- [ ] `npm test` passes (the pre-commit hook runs it; `npm run hooks` installs it)
- [ ] A test covers the bug, if this fixes one
- [ ] No new dependency — this project has none, on purpose
- [ ] Pages still do not call GoCD directly; requests go through the service worker
- [ ] No `innerHTML`, no `eval`, no `chrome.storage.sync`
- [ ] Comments explain *why* where the code looks odd but is deliberate
