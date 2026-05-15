# pi-chrome

> **The fastest way to give a [Pi](https://pi.dev) agent your real Chrome.**
> No remote-debug port. No throwaway profile. No re-login. Watch it work — or run silent.

**MIT · 0 runtime deps · loopback-only bridge (`127.0.0.1:17318`) · inspect [`extensions/chrome-profile-bridge/browser-extension/`](./extensions/chrome-profile-bridge/browser-extension) before loading.** Verify connectivity in one command: `/chrome doctor`.

```text
You:    "Find my open GitHub PR tab, summarize review state, and screenshot the failing CI."
Agent:  chrome_tab(list) → chrome_snapshot(uid:…) → chrome_screenshot(...)
        ✓ 3 reviewers, 1 change requested, CI red on iOS. Saved → .pi/chrome-screenshots/ci.png
You:    [keeps coding — agent never asked you to log in]
```

`pi-chrome` ships **19 browser tools** for Pi agents, backed by a small MIT-licensed Chrome extension that runs inside the Chrome profile **you already use** — including every site you're already signed into.

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

Verify, then authorize current Pi session from the terminal:

```text
/chrome doctor
/chrome authorize
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
Look at my GitHub notifications tab and triage which PRs
need my review today, sorted by staleness.
Don't click anything yet — just read and summarize.
```

You'll watch the agent jump to your GitHub tab and read the page — using **your** session, **your** filters, **your** orgs.

---

## Killer recipes (copy-paste into Pi)

Each recipe assumes the relevant tab is already open in the Chrome you control.

**PR triage**

```text
You:    "Look at my GitHub notifications tab and summarize the PRs needing my review today, sorted by staleness."
Agent:  chrome_tab(list) → chrome_snapshot(uid:el-notifications) → chrome_evaluate(...)
        ✓ 7 PRs waiting on you. 2 stale >3d (storage-rewrite, billing-v2).
          1 just turned CI-green (api-keys-prune). Full sorted list below.
You:    [pastes the list straight into Linear]
```

**Linear standup**

```text
You:    "Open my Linear current cycle and write a 5-bullet standup from it."
Agent:  chrome_tab(activate, urlIncludes:"linear.app") → chrome_snapshot(uid:el-cycle) → chrome_evaluate(...)
        ✓ 5 in-progress, 2 blocked. Standup draft:
          • Shipped: bridge auto-recover.   • In flight: input reliability path.
          • Blocked: vendor portal CSP (waiting on infra).
          • Next: benchmark v2.             • Risk: none today.
You:    [drops it into #standup]
```

**Bug repro with evidence**

```text
You:    "Reproduce the checkout 500 on staging. Save a screenshot at each step under ./repro/."
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
> Open my analytics dashboard tab and pull today's KPIs from the page.

**Network forensics**
> Reproduce the checkout bug, find the failing API call, and dump its response body.

**File upload through React**
> Open the photo uploader, upload `./fixtures/sample.png`, confirm the preview renders.

</details>

---

## Verifiable actions

Input tools return structured details such as the coordinates used, target tag, uploaded paths, key pressed, or scroll distance. For click/type/fill/key calls, pass `includeSnapshot: true` to get a fresh page snapshot in the same result:

```text
chrome_click(uid:"el-3", includeSnapshot:true) →
  result: { input:"chrome", x:412, y:238, tag:"BUTTON" }
  snapshot: { title, url, text, elements:[...] }
```

Agents can verify page state immediately instead of blindly retrying.

---

## What an agent gets

**19 tools**, grouped by job. Every one runs against your already-open tabs.

| Category        | Tools                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------- |
| **Tabs**        | `chrome_tab` (list/new/activate/close/version), `chrome_launch`                                |
| **Inspect**     | `chrome_snapshot` (uids + selectors + text + viewport), `chrome_screenshot`, `chrome_evaluate` |
| **Navigate**    | `chrome_navigate` (with optional `initScript` at `document_start`), `chrome_wait_for`          |
| **Interact**    | `chrome_click`, `chrome_type`, `chrome_fill`, `chrome_key`, `chrome_hover`                     |
| **Gesture**     | `chrome_drag` (Chrome pointer drag), `chrome_scroll` (wheel + momentum), `chrome_tap` (touch)  |
| **Files**       | `chrome_upload_file` (Chrome file-input control; no native picker)                             |
| **Observe**     | `chrome_list_console_messages`, `chrome_list_network_requests`, `chrome_get_network_request` (with response body) |

Each tool is documented inline in Pi — agents see the parameters and gotchas (Chrome input, CSP limits, file upload behavior) without trial-and-error.

---

## Click & input behavior

`pi-chrome` drives interactive controls through Chrome's real input layer: clicks, typing, fill, keys, hover, drag, scroll, and touch. Under the hood it uses `chrome.debugger` / CDP, so input satisfies normal user-activation gates. Chrome may show the *"Pi Chrome Connector started debugging this browser"* banner while attached.

### Authorization

Chrome control is locked by default. Before any agent can use `chrome_*` tools, explicitly authorize the current Pi session from the terminal with `/chrome authorize`.

```text
/chrome authorize          # default: authorize for 15 minutes
/chrome authorize 30m      # authorize for 30 minutes
/chrome authorize 45       # custom minutes
/chrome authorize indefinite # authorize until revoked or Pi exits
/chrome revoke             # lock again
/chrome status             # shows connection + auth + background
```

This protects your signed-in Chrome profile from accidental agent use. The loopback bridge also rejects browser-origin command requests so arbitrary web pages cannot call into `127.0.0.1:17318` through CORS.

### Run in background / watch modes

By default, every `chrome_*` call focuses Chrome and activates the target tab so you can **watch the agent work** — invaluable for demos, debugging, and first-time confidence.

```text
/chrome background          # toggle for the whole session
/chrome background on       # run in background
/chrome background off      # bring Chrome forward so you can watch
```

Per-call `background: true` wins over the session setting.

### Diagnostics

- `/chrome doctor` — single command: connectivity, extension version, bridge owner, version drift, MAIN-world helper injection, `chrome_evaluate("1+1") === 2`, fingerprint flags.
- `/chrome onboard` — guided first-time setup.
- `/chrome status` — current connection, authorization, and background state.
- `/chrome background status` — current watch/background setting.

If the loaded Chrome extension is older than `pi-chrome` on disk, `/chrome doctor` tells you to reload it from `chrome://extensions`.

---

## Architecture

```text
  +----------------------+                       +--------------------------+
  |  Pi agent (terminal) |  -- 127.0.0.1:17318 ->|  Chrome extension        |
  |  chrome_* tools      |                       |  (your real profile)     |
  +-----------+----------+                       +-------------+------------+
              |  same machine                                  |
              v                                                v
   Other Pi sessions                          Tabs you already have open
   share the same bridge                      (signed in to GitHub,
   automatically                               Linear, Stripe, etc.)
```

Multiple Pi sessions (planner / worker / audit) can all drive the same Chrome at once. The first session opens the local bridge; later sessions detect it and pipe their commands through.

---

## Built-in benchmark suite

[`test-suite/`](./test-suite) is a benchmark for **any** browser-control agent (not just pi-chrome). It includes **38 primitive challenges** plus **4 hermetic BrowserGym-style long-horizon tasks**.

Scoring tracks expected outcomes per challenge rather than raw PASS count, so tools are judged against their declared browser-control capability.

Each challenge exposes `window.__verdict` / `window.__reason` / `window.__events` and a manifest entry with expected results per mode.

```bash
cd test-suite && python3 -m http.server 8765
# open http://127.0.0.1:8765/ in the Chrome window pi-chrome controls
```

Categories: `real-input`, `pointer-humanization`, `keyboard`, `activation-gates`, `scroll`, `drag-drop`, `clipboard`, `native-controls`, `frameworks`, `editing`, `dom-complexity`, `frames`, `files`, `observability`, `fingerprint`, `agent-safety`.

If you build a competing tool, please open a PR with your scores. We benchmark in public.

---

## Security model & why unpacked

**Unpacked on purpose.** pi-chrome ships as an inspectable, MIT-licensed extension folder you load once with Developer Mode, so the local bridge and browser permissions are easy to audit and update without a Web Store release cycle. Every line is yours to read in [`extensions/chrome-profile-bridge/browser-extension/`](./extensions/chrome-profile-bridge/browser-extension). `/chrome doctor` reports the loaded extension version and warns when it drifts from your installed `pi-chrome`.

The companion extension runs in the Chrome profile where you install it and has broad tab/scripting permissions. Only install it from a package source you trust. Even after install, `chrome_*` tools stay locked until you run `/chrome authorize` in Pi. Use `/chrome revoke` to lock them again.

The Pi side listens on `127.0.0.1:17318` and rejects browser-origin command requests; ordinary web pages cannot use CORS to drive the bridge. The bundled Chrome extension currently polls that default port, so custom bridge ports are not supported without editing the extension source and reloading it.

There is no network exposure in the default configuration; the bridge binds to loopback only.

---

## Roadmap signals

`pi-chrome` is actively shipped. Things on the near roadmap:

- More observability tools (DOM mutation streams, performance traces)
- First-class iframe + Shadow-DOM uid stability across snapshots
- Web Push & service worker introspection
- Recorder mode that emits agent prompts from your own clicks

If you want one of those next, open an issue.

---

## License

MIT. See [LICENSE](./LICENSE).
