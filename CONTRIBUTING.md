# Contributing to pi-chrome

Thanks for considering a contribution. pi-chrome aims to be the **de-facto browser-control toolkit for Pi agents** — that means a few non-negotiables.

## Non-negotiables

1. **No re-login.** Every change must keep working against the user's already-signed-in Chrome profile. Anything that requires a fresh profile or extra auth steps is out of scope.
2. **Honest result envelopes.** Every action tool returns `pageMutated`, `defaultPrevented`, `elementVisible`, `occludedBy` (when relevant), `valueMatches` (for input). Agents need to know **why** something didn't take effect.
3. **Quiet by default, trusted by opt-in.** Synthetic DOM events first. CDP/`chrome.debugger` only when explicitly requested (`trusted: true`) or when the smart-auto heuristic detects an obvious user-activation gate.
4. **Benchmarks gate features.** Add a page in `test-suite/` that fails before your change and passes after. We accept PRs faster when there's a green/red verdict to point at.

## Local dev

```bash
# Link from a checkout
pi install ./pi-chrome

# Run the benchmark dashboard
cd test-suite
python3 -m http.server 8765
# open http://127.0.0.1:8765/ in the Chrome window pi-chrome controls
```

## Adding a new tool

1. Register in `extensions/chrome-profile-bridge/index.ts` (the `register*Tool` calls near line 840+).
2. Implement the handler in `extensions/chrome-profile-bridge/browser-extension/service_worker.js`.
3. Return a `pageMutated` + relevant fields.
4. Add a benchmark page under `test-suite/challenges/` and a manifest entry.
5. Update `README.md` "What an agent gets" table.
6. Add a `CHANGELOG.md` entry.

## Filing a bug

Include:

- `/chrome doctor` output
- `pi-chrome` version + extension version (the `doctor` output prints both)
- The exact tool call + the result envelope you got
- Page URL or a minimal repro page in `test-suite/`

## Releasing

- Bump `package.json` version.
- Move `CHANGELOG.md` notes from the working section to the new version header.
- `npm publish --access public`.

## Code of conduct

Be kind, be precise, ship things. PRs that break the "no re-login" promise will be closed with a note explaining which non-negotiable they hit.
