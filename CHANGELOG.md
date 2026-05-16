# Changelog

All notable user-facing changes to `pi-chrome`.

## 0.17.3 — 2026-05-16

### Daemon self-heal

0.17.x makes the Pi process a client of a separately-spawned daemon. If the daemon idle-shuts-down (after 10 min of inactivity) or is killed externally while a Pi session is running, the next chrome_* tool call or `/chrome onboard` would surface `fetch failed` instead of recovering.

- **`bridge.admin()`** catches the failed fetch, re-runs `ensureDaemonRunning()` (which probes, kills incompatible, or spawns fresh), then retries the request once.
- **`bridge.sendViaOwner()`** pre-probes `/status`; if no daemon is reachable, it spawns one before issuing the signed `/command`.

Net effect: a missing daemon transparently respawns on the next Pi-side request instead of bubbling `fetch failed` up to the user.

## 0.17.2 — 2026-05-16

### Fixes for the daemon model surfaced during 0.17.0/0.17.1 testing

- **Daemon: record `lastSeenAt` on *every* `/next` from a chrome-extension origin**, not only after the paired-auth checks. Pre-pairing the daemon returns `needsPairing: true` early; before this fix it never updated `lastSeenAt`, so the daemon's `connected` flag stayed `false` even when the extension was happily polling. `/chrome onboard` would loop forever on "Waiting for the extension to wake up…" even with a perfectly healthy extension.
- **Daemon compatibility is now checked at exact version match**, not just major.minor. Without this, a 0.17.x patch release that fixes a daemon bug couldn't actually replace the running 0.17.0 daemon — the new Pi client would `sameMajorMinor`-match the old daemon and join as client, never triggering a respawn. Patch releases now auto-kill+respawn the daemon, so daemon bug fixes ship cleanly via `pi update`.

## 0.17.1 — 2026-05-16

### Fix: `/chrome onboard` stuck on "Waiting for the extension to wake up…"

0.17.0 made the daemon (not the Pi process) own the HTTP listener, but the Pi client's
`bridge.status().connected` still reflected the *local Pi*'s `lastSeenAt`, which never gets
updated in the daemon model. Result: onboard's connect-wait loop spun forever even when the
extension was happily polling the daemon.

- New `ChromeProfileBridge.daemonStatus()` async method: fetches the daemon's `/status` and
  returns its view (the only correct source of truth in 0.17+).
- `/chrome onboard`, `/chrome doctor`, `/chrome status` now query `daemonStatus()` for the
  `connected` flag instead of reading stale Pi-side `lastSeenAt`.

## 0.17.0 — 2026-05-16

### Standalone daemon (no more owner-vs-client topology)

The Chrome bridge is now a separate, detached daemon process at `~/.cache/pi-chrome/<version>/daemon.cjs`. Every Pi session is a uniform client; the daemon's lifecycle is decoupled from any Pi session. Killing a Pi session never breaks Chrome control for other sessions, and `pi update` followed by starting any Pi session in a working directory automatically replaces an incompatible daemon with the new-version one.

- **`ChromeProfileBridge` is now a pure client.** No more `mode: "server"` branch on Pi side. `start()` ensures the daemon is running (probes `/status`, spawns from the versioned cache dir, kills+respawns an incompatible owner). `send()` always goes through signed `/command`.
- **Versioned daemon path.** Each pi-chrome version ships its own `daemon.cjs` and copies it to `~/.cache/pi-chrome/<version>/` on first use. Old versioned dirs coexist harmlessly; deleted by the daemon on a future release.
- **New signed `/admin` RPC.** Pi clients call `arm-pair-window`, `reset`, and `status` on the daemon over a signed peer→owner envelope (same broker-key contract as `/command`). Pre-pairing, the first `/admin` call is allowed unauthenticated; once paired, the daemon requires the broker-key envelope. `/chrome pair`, `/chrome unpair`, and `/chrome onboard` go through `/admin` instead of mutating state in-process.
- **`/heartbeat` endpoint** lets Pi clients keep the daemon's idle-shutdown timer alive between long gaps of chrome_* tool activity.
- **Daemon log** at `~/.cache/pi-chrome/<version>/daemon.log`. Use to debug spawn failures.
- **Idle shutdown.** Daemon exits after 10 minutes of no activity (no extension poll, no command). Next Pi session spawns it again.
- **Backward compatibility.** Wire protocol is byte-identical to 0.16.x; existing paired extensions don't need to re-pair. A 0.16.x bridge running at session_start is auto-replaced.

See [docs/DESIGN-0.17-daemon.md](./docs/DESIGN-0.17-daemon.md) for the architecture write-up.

## 0.16.1 — 2026-05-16

### Automatic stale-owner takeover at session_start

- **`bridge.start()` auto-takes over when the existing owner is unresponsive or running an incompatible major.minor version.** Probes `/status` with a 1s timeout; if the response is missing or carries a `bridgeVersion` that doesn't match this pi-chrome's major.minor, locates the owner PID via `lsof`, kills it (SIGTERM → SIGKILL escalation), and re-binds. Same-version owners are still joined as clients (multi-Pi sharing). This makes pi-chrome upgrades self-healing: just `pi update` then start a new Pi session, no manual `kill` required.
- **`/status` now includes `bridgeVersion`** so peer Pi sessions and tooling can make this decision deterministically.

### Idempotent `/chrome onboard` recovery flow

- **Foreign bridge-owner takeover.** When another Pi process (often an older pi-chrome that doesn't know about pairing) is holding `:17318`, onboard now detects it via `lsof`, confirms with the user, then `kill`s the foreign owner (SIGTERM → SIGKILL escalation), waits for the port to free, and re-binds the local bridge as server. Without this, onboarding from a peer Pi session would route through a stale owner forever.


Real-world failure: users on machines with an older pi-chrome extension installed couldn't get back to a working state. Onboard trusted confirm() clicks without verifying anything, the bridge could be in a half-paired state if the extension was reloaded with empty `chrome.storage.local`, and `/chrome status` / `doctor` blocked for up to 35 s waiting for a response from an extension that wasn't polling.

- **`/chrome onboard` (alias: `/chrome install`) is now safe to re-run any number of times.** Resets Pi-side pairing state first, walks the user through install OR reload (covering the v0.15.x → 0.16.x migration where the service worker must reload to gain the /pair logic), then **actively verifies** every step:
  - polls `bridge.status().connected` (15 s window) to confirm the extension is actually polling `/next` before issuing a pair invite,
  - polls `bridge.bridgeAuth.paired` after the user pastes the invite (no more "press Enter once it says paired" — detection is automatic),
  - round-trips a real `tab.version` command to confirm the end-to-end signed-envelope path works.
  - Any failure prints a concrete fix (wake the SW, re-load unpacked, switch to a normal tab, etc.).
- **`/chrome status` / `doctor` / `onboard` no longer hang.** New `probeExtension()` short-circuits before any `bridge.send()` when the bridge is unpaired or the extension hasn't polled recently; commands return immediately with an actionable message instead of waiting the full 5–35 s timeout.

## 0.16.0 — 2026-05-16

### Onboarding UX (same release)

- **`/chrome onboard` now runs both install + pair in one flow.** Two-step interactive walkthrough: (1) install/reload the Chrome extension (with auto-open of `chrome://extensions` + Finder + clipboard on macOS), (2) mint an invite, copy to clipboard, and wait for the user to paste into the extension popup. Returning users with an already-connected extension can skip step 1; users with an existing pairing get an explicit re-pair prompt. Pairing is no longer a separate step users have to remember.
- **`/chrome` command help reorganized** into First-time setup / Day-to-day / Maintenance groups so `onboard → authorize` is the obvious path.
- **Linux clipboard support** in the onboard/pair flow (tries `xclip` → `xsel` → `wl-copy`). macOS still uses `pbcopy`. Other platforms surface the invite text only; user copies manually.
- **README rewritten** with the install-then-pair flow front and center, a new "Why pairing?" section explaining the threat model in plain English, and a command-reference table.

### Ported from fork DaniBedz/pi-chrome (same release)

- **Early console/network capture at document_start.** Previously `chrome_list_console_messages` and `chrome_list_network_requests` returned empty for errors and requests fired during initial page load, because instrumentation only installed lazily when a chrome_* tool first ran. A new `chrome.webNavigation.onCommitted` listener now injects a self-contained `installEarlyCapture()` into MAIN world with `injectImmediately:true`, wrapping `console.{debug,log,info,warn,error}`, `fetch`, and `XMLHttpRequest` plus `error`/`unhandledrejection` listeners before the page's own code runs. Same `window.__PI_CHROME_STATE__` schema as the lazy path; idempotent via `__piChromeWrapped`. Boot-time React errors and initial API calls now appear in the console/network logs.
- **Quieter startup + dynamic status bar.** Removed the `session_start` info notify and the always-on `Chrome bridge :17318` status entry. The status bar now lights up as a green ● only after `/chrome authorize`, and clears on `/chrome revoke`. Onboarding (`/chrome onboard`) and pairing (`/chrome pair`) still print actionable instructions when invoked.

### Test-driven follow-ups (same release)

- **Paired `/next` distinguishes attack signal from migration.** With a paired bridge, a pinned origin that sends a present-but-invalid auth header (bad sig, replayed nonce, or stale ts) now gets a hard `401` instead of `200 needsPairing`. Missing-header from any chrome-extension origin still returns the soft migration response (so older unsigned extensions can read the version header and auto-reload). SW handles the new 401 by surfacing the pair badge and backing off; no exception throw, no auto-clear of keys.
- **Owner re-reads pairing state on every privileged request.** `BridgeAuth.refreshIfStale()` stats `~/.config/pi/chrome-bridge.json` and reloads if mtime changed (microseconds when unchanged), so cross-process mutations of the file — e.g. a peer running `/chrome unpair`, or an external `rm` — propagate immediately to the owner's in-memory state. Replay caches are dropped on key rotation. An `fs.watch` on the config directory is also installed as a prompt secondary signal; the per-request mtime check guarantees correctness even if the watch is missed.

### Red-team review follow-ups (same release)

- **CORS now allows/exposes the auth header** (`x-pi-chrome-auth`). Without this, some `fetch` implementations strip it on cross-origin extension responses.
- **Renamed header from `x-pi-pi-auth` to `x-pi-chrome-auth`.** Internal-only rename before any 0.16.x release.
- **`brokerKey` no longer leaves the Pi-side config.** The `/pair` response only returns `extensionPairKey`. Compromised extensions therefore can't extract the broker key used for peer-Pi `/command`.
- **Replay defense on response paths.** Added per-direction LRU nonce caches for `bridge->ext` (extension side) and `owner->peer` (peer-Pi side). The signature spec already covered these directions; the caches now actually enforce single-use nonces.
- **`reset()` and `persist()` chmod existing files.** `writeFileSync(mode)` is a no-op on an existing file; we now `chmodSync` to `0600` (and parent dir `0700`) on every write.
- **`readJsonBody` rejects non-object JSON** (null/array/string) with 400 instead of letting it through.
- **Top-level Content-Length precheck.** Oversized requests are 413'd before any auth/per-endpoint logic runs.
- **Stale-auth handling on the extension side.** When `/chrome unpair` is run on the Pi and the extension still has cached keys, the SW no longer loops on "bad /next signature". The unsigned-idle `{type:"none", needsPairing:true}` shape is accepted without a signature *only* when the bridge sends no auth header (never with a command), so the pair badge is surfaced and the user re-pairs from the popup.

### Original 0.16.0 changes

### Security hardening (red-team driven)

- **Mandatory pairing.** New `/chrome pair` issues a one-time invite the user pastes into the Chrome extension popup. Pairing pins the exact `chrome-extension://<id>` origin and derives HMAC keys via HKDF. Until paired, the bridge returns idle responses and refuses to deliver commands. `/chrome unpair` resets.
- **Signed envelopes on every privileged endpoint.** `/next`, `/result`, and `/command` now require an `X-Pi-Pi-Auth: v1 ts=... nonce=... sig=...` header signing protocol version, direction, method, path, extension ID, bridge ID, timestamp, nonce, and SHA-256 of the body. ±30 s clock window, 5-min LRU nonce replay defense, constant-time MAC compare. Bridge responses are signed too; the extension and peer Pi sessions verify before accepting commands or results.
- **Peer Pi sessions no longer ship a bearer token.** `/command` between Pi processes uses per-request signatures keyed by the broker HKDF key, and the owner's response is signed for verification. A pre-bind impostor without the pairing secret cannot impersonate or extract the keys.
- **Global loopback enforcement.** Every endpoint rejects non-loopback `remoteAddress`. `PI_CHROME_BRIDGE_HOST=0.0.0.0` is ignored unless `PI_CHROME_BRIDGE_DANGEROUS_REMOTE=1` is set, and even then the loopback check still applies.
- **Resource caps.** 1 MiB body cap (413), 256 queued/pending commands, 4 concurrent `/next` long-pollers (429). Malformed JSON now returns 400 instead of 500.
- **`crypto.randomUUID()` for command IDs** (was `Date.now()+Math.random()`).
- **`page.navigate` initScript** is now wrapped in `try/finally` around `chrome.tabs.update` and deleted in `onCommitted` *before* injection, so an aborted navigation cannot leave a stale init script armed for the next URL the user visits in that tab.
- **Manifest diet.** Dropped unused `activeTab` permission. Added popup UI (`popup.html` / `popup.js`) for pasting the pairing invite.

### Migration

Existing installations must run `/chrome pair` once after upgrading. Old extensions in the field receive a benign idle response plus the `x-pi-chrome-version` header, which still triggers the existing auto-reload path; the reloaded extension then surfaces a `pair` action badge.

## 0.15.20 — 2026-05-15

- **Interruptible `chrome_*` tools.** All `chrome_*` tools now honor the agent harness `AbortSignal`, so pressing Esc aborts in-flight bridge calls (including the long-polling `chrome_wait_for`) immediately instead of waiting out the full `timeoutMs`.

## 0.15.19 — 2026-05-14

- **Simpler package description.** README hero and npm/pi.dev description now use the same concise authorization-focused sentence.

## 0.15.18 — 2026-05-14

- **Cleaner package description.** npm/pi.dev description now focuses on the existing Chrome profile and explicit authorization model, avoiding implementation details.

## 0.15.17 — 2026-05-14

- **Docs accuracy pass.** Updated README, FAQ, comparison, contributing notes, and package metadata for the current real-input-only, terminal-authorized tool surface.
- **Input verification fix.** `includeSnapshot=true` now works for `chrome_click`, `chrome_type`, `chrome_fill`, and `chrome_key`, returning the Chrome-input result plus a fresh snapshot.

## 0.15.16 — 2026-05-14

- **Visible `/chrome` loading state.** Bare `/chrome` and `/chrome status` now immediately say “Checking Chrome connection…” before probing the companion extension, so a slow Chrome bridge no longer looks like the command did nothing.

## 0.15.15 — 2026-05-14

- **Terminal authorization restored.** `/chrome authorize` is back to terminal-based confirmation. Removed the browser-side Chrome consent page and companion-extension consent polling.

## 0.15.14 — 2026-05-14

- **Clearer consent wait state.** After the Chrome approval page opens, Pi now says “Approve or deny the Chrome approval page to continue” instead of looking stuck at the launch step.

## 0.15.13 — 2026-05-14

- **Fix Chrome-side consent hang.** `/chrome authorize` now launches the browser consent page as a short command, then polls for the decision. This avoids holding one long extension command open while the user reads/clicks the page, which could leave Pi stuck at “Opening Chrome approval page…”.

## 0.15.12 — 2026-05-14

- **Docs accuracy.** Clarified that the bundled Chrome extension currently polls `127.0.0.1:17318`; custom bridge ports are not supported without editing/reloading the extension source. Also softened the unpacked-extension rationale to avoid overstating Web Store limitations and fixed stale strict-CSP guidance for `chrome_evaluate`.

## 0.15.11 — 2026-05-14

- **README cleanup.** Removed the Playwright/CDP/Selenium comparison table and low-signal Composes with / Contributing sections from the package page because they are noisy and easy to drift.

## 0.15.10 — 2026-05-14

- **Browser-side Chrome consent.** `/chrome authorize` now opens a Pi Chrome Connector approval page inside Chrome showing duration, workspace, process id, and extension/package versions. Chrome control unlocks only after the user approves there; denying, closing the tab, or timeout leaves control locked.
- **README cleanup.** Removed npm/download/license shield badges from the package page because they are noisy and easy to drift.

## 0.15.9 — 2026-05-14

- **Tighter `/chrome` menu.** Removed the redundant “Connection status” item from the interactive `/chrome` menu because connection/auth/background are already shown in the menu header. `/chrome status` remains available as a slash command.

## 0.15.8 — 2026-05-14

- **Simpler `/chrome` submenus.** Authorize menu now offers 15 minutes, 30 minutes, indefinite, and custom minutes only. Background menu now offers only foreground/background. Esc from a submenu returns to the main `/chrome` menu.

## 0.15.7 — 2026-05-14

- **Grouped `/chrome` menu.** Bare `/chrome` now opens a status dashboard with grouped actions: authorize, lock, status, doctor, background/watch mode, and onboard. Authorize/background open submenus instead of showing one flat command list.

## 0.15.6 — 2026-05-14

- **Bare `/chrome` is now a command menu.** Running `/chrome` shows interactive options for every `/chrome ...` command, including authorize/revoke/status/doctor/onboard/background variants.

## 0.15.5 — 2026-05-14

- **Chrome control authorization.** `chrome_*` tools are locked until the user runs `/chrome authorize` in the current Pi session. Grants can be one command, 15 minutes, 1 hour, or the session; `/chrome revoke` locks control again and `/chrome status` shows auth state.
- **Browser-origin bridge hardening.** The loopback bridge no longer sends wildcard CORS headers. `/command` accepts only local-process requests, while extension polling/result endpoints reject non-extension browser origins, blocking ordinary web pages from driving or draining the bridge through `127.0.0.1`.

## 0.15.4 — 2026-05-14

- **Quiet renamed to background.** Public UX now uses `/chrome background [on|off|toggle|status]` and docs/status say “run in background” instead of “quiet mode”.

## 0.15.3 — 2026-05-14

- **Chrome real input only.** Public trusted/synthetic mode controls were removed. Interactive tools now always use Chrome's real input layer; `/chrome clicks` and public `trusted` parameters are gone.

## 0.15.2 — 2026-05-13

- **Recipe prompts rewritten in user-language.** Earlier recipes leaked tool names into the `You:` prompts ("Use `chrome_tab list` to find my GitHub notifications tab…"), implying users need to know the tool catalog before they can ask anything. Prompts now read as natural intent; the agent trace below each one still shows the `chrome_*` primitives the agent picked. Affects the 30-second try-this block, all 3 hero recipes (PR triage / Linear standup / Bug repro), and 3 of the 6 collapsed recipes (auth-only data pull, network forensics, file upload).

## 0.15.1 — 2026-05-13

- **Architecture diagram now renders on pi.dev.** Replaced Unicode box-drawing characters (`┌─┐│└┘┬▼`) with plain ASCII (`+ - | v`). Pi.dev's monospace font was dropping the horizontal `─` glyphs, leaving the diagram as floating vertical bars. ASCII renders everywhere.
- **`author` switched to object form.** Was `"tianrendong (Earendil Inc.)"` — npm's author-string spec parses `(parens)` as the URL slot, so `"Earendil Inc."` ended up in `author.url`. Now `{ "name": "tianrendong", "company": "Earendil Inc." }`.

## 0.15.0 — 2026-05-13

- **README rewrite — top-3 recipes as terminal mockups.** PR triage, Linear standup, and Bug-repro-with-evidence each get a copy-pasteable prompt → tool trace → result block modeled on the hero example. The other six recipes (form auto-fill, admin cross-check, visual diff, auth-only data pull, network forensics, file upload) collapsed into a `<details>` block so the section sells before it catalogs.
- **Comparison table rewritten.** Dropped the all-✅ "Works on strict-CSP pages" row (zero signal). New table leads with "Time from `pi install` → first useful action on your real account" (~60s vs. hours) and "Survives MFA / SSO without code" (✅ already logged in). Multi-session row reframed as the bolded "Multiple agents drive the same Chrome at once". Footnote ² rewritten to highlight mode-aware scoring + open invitation for competing tools to PR their scores.
- **Section reorder: sells before catalogs.** New flow: hero → 60-second install → 30-second try-this → killer recipes → comparison → honest results → tool catalog → click/watch modes (with Diagnostics folded in) → architecture → benchmark suite → security model & why unpacked (combined) → composes-with → roadmap → contributing → license. Hero blockquote now precedes shields badges so pi.dev no longer scrapes a broken-image badge as the description. Package `description` shortened to 255 chars so pi.dev hero stops truncating mid-word. `author` set to `"tianrendong (Earendil Inc.)"`.

## 0.14.9

- Primer (agent system prompt) now teaches the **trusted-mode escape hatch** explicitly. Previously the bridge would hit a CSP-locked page (github.com, banks, many SaaS apps), `chrome_evaluate`/`chrome_snapshot` would throw `EvalError: 'unsafe-eval' is not an allowed source of script`, and the agent would conclude *"bridge can't drive this page"* and ask the user for a fallback. New primer makes three things self-discoverable: (1) `trusted: true` on click/type/key/fill/hover/drag/scroll dispatches through chrome.debugger / CDP and bypasses page CSP entirely, (2) the recipe for strict-CSP pages is `chrome_screenshot` + trusted input at viewport coordinates, (3) when synthetic input produces no `pageMutated` or you see a CSP/eval error, **escalate to `trusted: true` yourself instead of asking the user**. Also corrects the old claim that `chrome_evaluate` works without `'unsafe-eval'` (it does not — Function constructor is gated by `script-src`).
- Add `scripts/sync-manifest-version.js` wired to npm's `version` + `prepublishOnly` lifecycle hooks. Bumping the package version with `npm version <bump>` now auto-syncs `extensions/chrome-profile-bridge/browser-extension/manifest.json` and stages it into the version commit — kills the recurring drift class (cf. 0.14.4, 0.14.8, this fix).

## 0.14.8

- Repo moved to its own home: https://github.com/tianrendong/pi-chrome. No code changes; updated `repository`, `homepage`, and `bugs` URLs in `package.json`.

## 0.14.7

- Replace "30+ challenges" hand-wave in README + COMPARISON.md with the accurate framing from chrome-benchmark: **38 primitive challenges + 4 hermetic BrowserGym-style long-horizon tasks**, scored by **expected-outcome-by-mode** (not raw PASS count). Explains why a synthetic-events tool isn't supposed to satisfy a clipboard user-activation gate — matching that expectation is the pass.

## 0.14.6

- Fix Browser Use license in `docs/COMPARISON.md`: MIT (not Apache-2.0). Confirmed against upstream LICENSE on GitHub.

## 0.14.5

- `docs/COMPARISON.md` rewritten with a three-axis landscape (drivers / agent frameworks / cloud providers). Adds Browser Use, Stagehand, Skyvern, Magnitude, Alumnium, OpenAI Operator, Project Mariner, Surfer 2, Anthropic Computer Use, Browserbase, Steel.dev, Hyperbrowser, Anchor, Browserless. Adds Interop section, public-benchmark cheat sheet (WebArena, WorkArena++, BrowseComp, Mind2Web 2, WebChoreArena, MiniWoB++, BrowserGym).
- README gains a one-liner pointing at the new three-axis framing.
- Sourced from `benchmark-search` session research. No code changes.

## 0.14.4

- Sync `manifest.json` version to match `package.json` (0.14.3 shipped with stale manifest, would trigger spurious `/chrome doctor` drift warnings). No code or behavior changes.

## 0.14.3

- Documentation & discoverability overhaul.
- New README: hero, alternatives comparison table, 20-tool reference grouped by job, killer recipes, architecture diagram, honest-results explainer, benchmark suite plug.
- `docs/COMPARISON.md` — deep comparison vs Playwright / Puppeteer / Stagehand / browser-use / Selenium.
- `docs/EXAMPLES.md` — ready-to-paste agent prompts (PR triage, Linear standup, bug repro, network forensics, multi-tab admin cross-check, etc.).
- `docs/FAQ.md` — covers Brave/Arc, incognito, detection, banner, multi-session, CSP, file uploads, common envelope causes.
- `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE` added.
- `package.json`: `homepage`, `repository`, `bugs`, expanded keywords for npm search.
- No code changes to the tools or extension.

## 0.14.2

- Recover from foreign-extension input overlays so input tools don't get hijacked by other Chrome extensions.

## 0.14.1

- Harder `attachDebugger` retry path so trusted clicks survive transient Chrome debugger contention.
- New `trusted.debug` diagnostic surface.

## 0.14.0

- Bare `/chrome` opens a `SettingsList` dialog. `space` cycles values, `enter` saves.

## 0.13.0

- Flattened `/chrome` tree. Cycle-on-pick for `clicks` / `quiet`. Status header at the top of the picker.

## 0.12.1

- Fixed anti-automation regressions across 7 benchmark challenges (`07/13/21/27/28`).

## 0.12.0

- Unified all slash commands under `/chrome` (`/chrome doctor`, `/chrome onboard`, `/chrome clicks`, `/chrome quiet`).

## 0.11.x

- Plain-English audit pass across `/chrome doctor`, `/chrome onboard`, `/chrome quiet`, README.
- `chrome_tap` (real CDP touch events).
- Smoother `trustedScroll`; CDP debugger auto-recovers from detach.
- Smart-auto trusted mode default. Extension renamed to **Pi Chrome Connector**.
- Per-event scroll delta cap so IntersectionObserver thresholds land naturally.

## 0.10.x

- Trusted-input mode via `chrome.debugger` (CDP) — opt-in, indistinguishable-from-human clicks/keys.
- `chrome_key` modifiers (Cmd+V, Ctrl+Shift+Tab, etc.) for trusted chords.
- Interactive `/chrome-trusted` picker (later folded into `/chrome`).

## 0.9.x

- Humanized synthetic input (pointer paths, key cadence variance).
- Anti-automation benchmark test suite landed in `test-suite/`.

## 0.8.0

- `chrome_evaluate` no longer returns `null` for valid expressions — dedicated MAIN-world `evaluateInTab` pipeline with statement-mode fallback and tagged envelope for `undefined`/errors/symbols/bigints.
- Truthful action result envelopes: `isTrusted`, `defaultPrevented`, `elementVisible`, `occludedBy`, `valueMatches`, `pageMutated`.
- Extended `/chrome doctor`: bridge mode/URL, extension version drift, MAIN-world helper injection, `navigator.webdriver` fingerprint, CDP availability probe.
- Removed misleading `returnByValue` param. Implemented `chrome_screenshot.fullPage` via tile stitching.
- Autoplay-gate heuristic for `chrome_click`.

## 0.7.0

- Initial public `pi-chrome` release. Companion Chrome extension + local bridge + first tool set.
