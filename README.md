# pi-chrome

> **The fastest way to give a [Pi](https://pi.dev) agent your real Chrome.**
> No CDP. No throwaway profile. No re-login. Watch it work — or run silent.

**MIT · 0 runtime deps · loopback-only bridge (`127.0.0.1:17318`) · inspect [`extensions/chrome-profile-bridge/browser-extension/`](./extensions/chrome-profile-bridge/browser-extension) before loading.** Verify connectivity in one command: `/chrome doctor`.

```text
You:    "Find my open GitHub PR tab, summarize review state, and screenshot the failing CI."
Agent:  chrome_tab(list) → chrome_snapshot(uid:…) → chrome_screenshot(...)
        ✓ 3 reviewers, 1 change requested, CI red on iOS. Saved → .pi/chrome-screenshots/ci.png
You:    [keeps coding — agent never asked you to log in]
```

[![npm version](https://img.shields.io/npm/v/pi-chrome.svg)](https://www.npmjs.com/package/pi-chrome)
[![npm downloads](https://img.shields.io/npm/dm/pi-chrome.svg)](https://www.npmjs.com/package/pi-chrome)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

`pi-chrome` ships **20+ browser tools** for Pi agents, backed by a small MIT-licensed Chrome extension that runs inside the Chrome profile **you already use** — including every site you're already signed into.

---

## 60-second install

```bash
pi install npm:pi-chrome
```

Then in Pi:

```text
/chrome onboard
```

On macOS this opens `chrome://extensions`, reveals the bundled `browser-extension/` folder in Finder, and copies its path to your clipboard. In Chrome: **Developer mode** → **Load unpacked** → paste the path. Done.

Verify:

```text
/chrome doctor
```

```text
Performing Chrome bridge health check
pi-chrome v<version>
• Local bridge: mode=server, url=http://127.0.0.1:17318
✓ Companion Chrome extension responding (ID: <chrome-extension-id>, ext v<version>)
```

---

## Try this in 30 seconds after install

```text
Use chrome_tab list to find my GitHub notifications tab.
chrome_snapshot it, then write a 5-bullet triage:
which PRs need my review today, sorted by staleness.
Do not click anything yet.
```

You'll watch the agent jump to your GitHub tab and read the page — using **your** session, **your** filters, **your** orgs.

---

## Killer recipes (copy-paste into Pi)

Each recipe assumes the relevant tab is already open in the Chrome you control.

**PR triage**

```text
You:    "Use chrome_tab list to find my GitHub notifications tab, then summarize PRs needing my review today, sorted by staleness."
Agent:  chrome_tab(list) → chrome_snapshot(uid:el-notifications) → chrome_evaluate(...)
        ✓ 7 PRs waiting on you. 2 stale >3d (storage-rewrite, billing-v2).
          1 just turned CI-green (api-keys-prune). Full sorted list below.
You:    [pastes the list straight into Linear]
```

**Linear standup**

```text
You:    "Open my Linear current cycle in the active tab and write a 5-bullet standup."
Agent:  chrome_tab(activate, urlIncludes:"linear.app") → chrome_snapshot(uid:el-cycle) → chrome_evaluate(...)
        ✓ 5 in-progress, 2 blocked. Standup draft:
          • Shipped: bridge auto-recover.   • In flight: trusted-mode retry path.
          • Blocked: vendor portal CSP (waiting on infra).
          • Next: benchmark v2.             • Risk: none today.
You:    [drops it into #standup]
```

**Bug repro with evidence**

```text
You:    "Repro the checkout 500 on staging, save a screenshot at each step under ./repro/."
Agent:  chrome_navigate(staging) → chrome_click(uid:el-add-to-cart) → chrome_screenshot(./repro/01-cart.png)
        → chrome_click(uid:el-checkout) → chrome_list_network_requests() → chrome_screenshot(./repro/02-500.png)
        ✓ POST /api/checkout → 500. Response body saved → ./repro/checkout-500.json
          3 screenshots in ./repro/. Trigger: missing tax_id when cart contains digital goods.
You:    [files the ticket with the folder attached]
```

<details>
<summary><strong>More recipes</strong> (form auto-fill, admin cross-check, visual diff, auth-only data pull, network forensics, file upload)</summary>

**Form auto-fill (no submit)**
> Open the vendor portal, fill the new-vendor form from this JSON, stop before submit.

**Admin cross-check**
> Across my Stripe / Postmark / our admin tabs, find any user where state disagrees.

**Local dev visual diff**
> Snapshot `localhost:3000` and the staging URL of the same page; tell me what's visually different.

**Auth-only data pull**
> Open my analytics dashboard tab and `chrome_evaluate` to extract today's KPIs from page state.

**Network forensics**
> Reproduce the checkout bug, then use `chrome_list_network_requests` to find the failing call and dump its response body.

**File upload through React**
> Open the photo uploader, `chrome_upload_file` with `./fixtures/sample.png`, confirm preview rendered.

</details>

---

## Why pi-chrome vs. Playwright / CDP / Selenium

> Short version: **pi-chrome is primitives — "Playwright for the Chrome you're already signed into."** Not an agent loop. Plug it under any agent framework (Browser Use, Stagehand, LangGraph) or call its tools directly from a Pi agent. See [docs/COMPARISON.md](./docs/COMPARISON.md) for the full three-axis landscape (drivers, agents, cloud providers).

|                                | **pi-chrome**                     | Playwright / Puppeteer        | CDP-based agents              | Selenium / WebDriver          |
| ------------------------------ | --------------------------------- | ----------------------------- | ----------------------------- | ----------------------------- |
| **Time from `pi install` → first useful action on your real account** | ~60s (load unpacked, `/chrome doctor`) | hours (script login, store creds, debug headless) | 30+ min (`--remote-debug` setup, attach) | hours (driver + login script) |
| **Survives MFA / SSO without code** | ✅ already logged in              | ❌                             | ⚠️ if you re-auth             | ❌                             |
| Uses your real signed-in Chrome | ✅ extension in your profile      | ❌ throwaway profile           | ⚠️ requires `--remote-debug`  | ❌ throwaway profile           |
| Re-login required               | **Never**                         | Every run                     | Sometimes                     | Every run                     |
| **Multiple agents drive the same Chrome at once** | ✅ shared bridge | ❌ port collisions             | ❌                             | ❌                             |
| Watch agent work, live          | ✅ default; toggle quiet          | ❌ headless or new window      | ⚠️ debugger banner always     | ❌ new window                  |
| Real browser-trusted clicks     | ✅ opt-in (`chrome clicks on`)    | ✅                             | ✅                             | ✅                             |
| Network/console capture         | ✅ built-in                       | ✅                             | ✅                             | ⚠️ via extensions             |
| **Honest result envelopes¹**    | ✅                                 | ⚠️                            | ❌                             | ❌                             |
| Self-graded by built-in benchmark² | ✅ 38 primitives + 4 long-horizon | n/a                          | n/a                           | n/a                           |

¹ Every action returns `pageMutated`, `defaultPrevented`, `elementVisible`, `occludedBy`, and `valueMatches` so the agent knows when a click didn't take effect — instead of looping blindly.
² [`test-suite/`](./test-suite) is mode-aware: a synthetic-events tool is *expected* to fail clipboard. If you build a competing tool, send a PR with your scores. We benchmark in public.

---

## Honest results

Most browser-automation libraries return `void` or a generic ack. `pi-chrome` returns a structured envelope on every interaction:

```text
chrome_click(occluded-button) →
  "Clicked el-3 — pageMutated=false; occluded by <div#overlay>"
```

```text
chrome_type(react-input, "hello") →
  "Typed into el-7 — valueMatches=true; pageMutated=true"
```

This is why agents using pi-chrome don't get stuck in retry loops on broken sites. They get the **reason** the action didn't land and can fix course in one turn.

---

## What an agent gets

**20 tools**, grouped by job. Every one runs against your already-open tabs.

| Category        | Tools                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------- |
| **Tabs**        | `chrome_tab` (list/new/activate/close/version), `chrome_launch`                                |
| **Inspect**     | `chrome_snapshot` (uids + selectors + text + viewport), `chrome_screenshot`, `chrome_evaluate` |
| **Navigate**    | `chrome_navigate` (with optional `initScript` at `document_start`), `chrome_wait_for`          |
| **Interact**    | `chrome_click`, `chrome_type`, `chrome_fill`, `chrome_key`, `chrome_hover`                     |
| **Gesture**     | `chrome_drag` (HTML5 DataTransfer), `chrome_scroll` (wheel + momentum), `chrome_tap` (touch)   |
| **Files**       | `chrome_upload_file` (no native picker; works with React/Vue/Angular file inputs)              |
| **Observe**     | `chrome_list_console_messages`, `chrome_list_network_requests`, `chrome_get_network_request` (with response body) |

Each tool is documented inline in Pi — agents see the parameters and the gotchas (synthetic vs. trusted, autoplay gates, file picker limits) without trial-and-error.

---

## Click & input modes

`pi-chrome` can drive Chrome two ways:

- **Quiet** — synthetic DOM events. Fast, no UI banners. Drives React/Vue/Angular state. Won't satisfy autoplay, clipboard, file picker, fullscreen, or user-activation gates.
- **Trusted** — `chrome.debugger` / CDP under the hood. Indistinguishable from a person clicking. Shows Chrome's *"Pi Chrome Connector started debugging this browser"* banner while active.

```text
/chrome clicks auto     # default: quiet, upgrade to trusted only when needed
/chrome clicks off      # always quiet, never banner
/chrome clicks on       # always trusted, banner stays up
/chrome clicks status
```

Per-call `trusted: true / false` on any input tool wins over the global mode.

### Background / watch modes

By default, every `chrome_*` call focuses Chrome and activates the target tab so you can **watch the agent work** — invaluable for demos, debugging, and first-time confidence.

```text
/chrome quiet          # toggle for the whole session
/chrome quiet on       # explicit
/chrome quiet off      # explicit
```

Per-call `background: true` wins over the session toggle.

### Diagnostics

- `/chrome doctor` — single command: connectivity, extension version, bridge owner, version drift, MAIN-world helper injection, `chrome_evaluate("1+1") === 2`, fingerprint flags.
- `/chrome onboard` — guided first-time setup.
- `/chrome quiet status`, `/chrome clicks status` — current modes.

If the loaded Chrome extension is older than `pi-chrome` on disk, `/chrome doctor` tells you to reload it from `chrome://extensions`.

---

## Architecture

```
  ┌──────────────────────┐                         ┌──────────────────────────┐
  │  Pi agent (terminal) │  ─── http://127.0.0.1:17318 ─→  │ Chrome extension     │
  │  chrome_* tools      │                         │ (your real profile)      │
  └──────────┬───────────┘                         └─────────┬────────────────┘
             │ same machine                                  │
             ▼                                               ▼
   Other Pi sessions                              Tabs you already have open
   share the same bridge                          (signed in to GitHub,
   automatically                                   Linear, Stripe, etc.)
```

Multiple Pi sessions (planner / worker / audit) can all drive the same Chrome at once. The first session opens the local bridge; later sessions detect it and pipe their commands through.

---

## Built-in benchmark suite

[`test-suite/`](./test-suite) is a benchmark for **any** browser-control agent (not just pi-chrome). It includes **38 primitive challenges** plus **4 hermetic BrowserGym-style long-horizon tasks**.

Scoring is **expected-outcome-by-mode**, not raw PASS count: each challenge has an expected verdict per mode (`synthetic`, `trusted`, `manual`) and a tool grades itself by whether its actual outcome matches the expected one. This avoids false equivalence between modes — a synthetic-events tool isn't supposed to satisfy a clipboard user-activation gate; matching that expectation is the pass.

Each challenge exposes `window.__verdict` / `window.__reason` / `window.__events` and a manifest entry with expected results per mode.

```bash
cd test-suite && python3 -m http.server 8765
# open http://127.0.0.1:8765/ in the Chrome window pi-chrome controls
```

Categories: `trusted-input`, `pointer-humanization`, `keyboard`, `activation-gates`, `scroll`, `drag-drop`, `clipboard`, `native-controls`, `frameworks`, `editing`, `dom-complexity`, `frames`, `files`, `observability`, `fingerprint`, `agent-safety`.

If you build a competing tool, please open a PR with your scores. We benchmark in public.

---

## Security model & why unpacked

**Unpacked on purpose.** A Web Store extension cannot talk to a local bridge controlled by another tool on the same machine — so pi-chrome ships its bridge as an inspectable, MIT-licensed folder you load once with Developer Mode. Every line is yours to read in [`extensions/chrome-profile-bridge/browser-extension/`](./extensions/chrome-profile-bridge/browser-extension). `/chrome doctor` reports the loaded extension version and warns when it drifts from your installed `pi-chrome`.

The companion extension runs in the Chrome profile where you install it and has broad tab/scripting permissions. Only install it from a package source you trust.

The Pi side listens on `127.0.0.1:17318` by default. Override before starting Pi:

```bash
PI_CHROME_BRIDGE_PORT=17319 pi
```

There is no network exposure; the bridge binds to loopback only.

---

## Composes with

- **[pi-qq](https://www.npmjs.com/package/pi-qq)** — `/qq summarize what the active GitHub tab shows` without polluting the main transcript.
- **[pi-bar](https://www.npmjs.com/package/pi-bar)** — when the agent scrapes large pages, watch the context-usage segment turn yellow → red as a signal to `/qq` for a recap.
- **PR demo skills** — screenshots write to `.pi/chrome-screenshots/` so you can attach them to PR descriptions or demo bundles.

---

## Roadmap signals

`pi-chrome` is actively shipped. Things on the near roadmap:

- More observability tools (DOM mutation streams, performance traces)
- First-class iframe + Shadow-DOM uid stability across snapshots
- Web Push & service worker introspection
- Recorder mode that emits agent prompts from your own clicks

If you want one of those next, open an issue.

---

## Contributing

PRs welcome. The bar:

1. Add a benchmark page in `test-suite/` that fails before your change and passes after.
2. Keep `chrome_*` tool results honest — surface `pageMutated`, `valueMatches`, `defaultPrevented`, etc.
3. Don't break the "no re-login" guarantee. Anything that requires a fresh profile is out of scope.

---

## License

MIT. See [LICENSE](./LICENSE).
