# pi-chrome

[![npm version](https://img.shields.io/npm/v/pi-chrome.svg)](https://www.npmjs.com/package/pi-chrome)

Control the Chrome profile you already use from Pi.

`pi-chrome` gives Pi agents browser tools for your **real Chrome windows, tabs, and authenticated sessions**. It uses a companion Chrome extension instead of the Chrome DevTools Protocol (CDP), so it does not launch a throwaway debug browser profile and does not require re-signing into the apps you already have open.

Multiple Pi sessions can use Chrome at the same time. The first Pi session starts the local bridge; later sessions automatically detect that bridge and submit their Chrome commands through it.

## Why try it?

- **Uses your existing Chrome profile** — works with the Chrome windows/tabs you are already using, including logged-in GitHub, admin dashboards, local apps, and internal tools.
- **Watch your authenticated Chrome work** — by default, `chrome_*` tool calls focus Chrome and activate the target tab so you can see the agent inspect, navigate, click, and type in real time. Switch to silent/background mode for the whole session with `/chrome quiet`, or pass `background: true` on a single tool call when you want quiet.
- **Full browser automation toolkit for Pi** — list/create/activate/close tabs, snapshot pages with usable CSS selectors, navigate, evaluate JavaScript, click, type, press keys, wait for page state, and capture screenshots.
- **Built-in setup and agent guidance** — `/chrome onboard` walks users through installing the companion extension, `/chrome doctor` checks connectivity and version drift, screenshots save to disk, and the prompt primer tells agents to inspect with `chrome_snapshot` before acting and avoid destructive actions unless explicitly requested.

## Install

```bash
pi install npm:pi-chrome
```

For local development from a checkout:

```bash
pi install ./pi-chrome
```

### Why an unpacked Chrome extension?

`pi-chrome` cannot ship through the Chrome Web Store: a Web Store extension is not allowed to talk to a local bridge controlled by another tool. Instead it ships as a small, MIT-licensed unpacked extension in `extensions/chrome-profile-bridge/browser-extension/` — read the source before loading. `/chrome doctor` reports the loaded extension version and warns when it drifts from the installed `pi-chrome`.

## First-time setup

In Pi, run:

```text
/chrome onboard
```

Pi first shows setup instructions and waits for confirmation. Press Enter to continue. On macOS it will:

- open `chrome://extensions`
- reveal the bundled `browser-extension` folder in Finder
- copy the extension folder path to your clipboard

Then in Chrome:

1. Enable **Developer mode**.
2. Click **Load unpacked**.
3. Select the revealed/copied `browser-extension` folder.
4. Return to Pi and run:

```text
/chrome doctor
```

Expected output:

```text
Performing Chrome bridge health check
pi-chrome v<version>
• Local bridge: mode=server, url=http://127.0.0.1:17318
✓ Companion Chrome extension responding (ID: <chrome-extension-id>, ext v<version>)
```

## Click modes

pi-chrome can drive Chrome two ways:

- **Quiet clicks** — fast and unobtrusive. They work on most sites, but some pages (sign-in flows, copy-to-clipboard buttons, file pickers, autoplay videos, fullscreen, paywalls) ignore them because they don't look like a real human action.
- **Real-looking clicks** — indistinguishable from a person clicking. They unlock the cases above, but Chrome shows a *"Pi Chrome Connector started debugging this browser"* banner at the top of every tab pi-chrome touches while it's working.

Pick a mode with `/chrome clicks`:

```text
/chrome clicks auto     # default; quiet by default, real-looking only when needed
/chrome clicks off      # always quiet, no banner ever
/chrome clicks on       # always real-looking, banner stays up the whole session
/chrome clicks status   # show the current mode
```

For a one-off call, pass `trusted: true` (or `false`) on `chrome_click`, `chrome_type`, `chrome_fill`, `chrome_key`, `chrome_hover`, `chrome_drag`, or `chrome_scroll`. The per-call value wins over the global mode.

First time you update pi-chrome to a version that supports real-looking clicks, Chrome will ask you to re-approve the extension. Open `chrome://extensions` and accept the new permission once.

## Background mode

By default, `chrome_*` tools focus Chrome and activate the target tab so you can watch the agent work — great for demos, pair-driving, debugging, and first-time confidence that things are happening.

When you want quiet (planner / audit / worker sessions running alongside your editor), turn background mode on for the whole Pi session:

```text
/chrome quiet          # toggle
/chrome quiet on       # explicit
/chrome quiet off      # explicit
```

For a single tool call, the agent can pass `background: true` directly. The per-call value always wins over the session toggle.

## Quick demo prompts

After setup, try one of these in Pi:

Silent inspection (no Chrome interruption):

```text
Inspect my active GitHub tab with chrome_snapshot using background:true and summarize the PR state without focusing Chrome.
```

Existing authenticated tab:

```text
Use chrome_tab list to find my existing GitHub tab, chrome_snapshot it, then summarize the visible PR state. Do not click anything yet.
```

Local web app repro with screenshot:

```text
Use chrome_tab list to find my localhost app, inspect it with chrome_snapshot, navigate through the bug repro flow, and save a screenshot when you reach the broken state.
```

## Recipes

Copy-paste these into Pi after setup. Each one uses tabs you already have open and accounts you are already signed into.

- **PR triage:** "Use chrome_tab list to find my GitHub notifications tab, snapshot it, and summarize PRs needing my review."
- **Linear standup:** "Open my Linear current cycle in the active tab, snapshot it, and write me a 5-bullet standup."
- **Bug repro with evidence:** "Open the staging app I'm already signed into, reproduce <bug>, and save a screenshot of each step under ./repro/."
- **Form auto-fill (no submit):** "Open <vendor> portal, fill the new-vendor form from this JSON, but stop before submit."
- **Admin cross-check:** "Across my Stripe / Postmark / our admin tabs, find any user where state disagrees."
- **Local dev visual diff:** "Snapshot localhost:3000 and the staging URL of the same page; tell me what's visually different."
- **Auth-only data pull:** "Open my analytics dashboard tab and chrome_evaluate to extract today's KPIs from the page state."

Screenshots save under `.pi/chrome-screenshots/` by default, which composes nicely with PR demo workflows.

## Diagnostics

- `/chrome doctor` — single command that checks connectivity and reports the loaded Chrome extension ID + version, plus a one-line fix for common setup failures (extension not loaded, bridge owner stale after `pi update`, version mismatch between pi-chrome and the loaded Chrome extension).

If the Chrome extension you have loaded is older than `pi-chrome` on disk, `/chrome doctor` will tell you to reload it from `chrome://extensions`.

## Compose with

- **pi-qq** — ask side questions about what the agent saw in Chrome without polluting the main transcript: `/qq summarize what the active GitHub tab shows`.
- **pi-bar** — watch context pressure as the agent scrapes large pages; the footer's red threshold is a clean signal to `/qq` for a recap before context overflows.
- **PR demo skills** (such as `ios-pr-agent` / `ios-demo-record` workflows) — `chrome_screenshot` writes to `.pi/chrome-screenshots/` so you can attach images to PR descriptions or demo bundles.

## Tools

The package registers these Pi tools:

- `chrome_launch` — setup/help entry point; opens a URL if the bridge is connected
- `chrome_tab` — list, create, activate, close, or inspect tabs
- `chrome_snapshot` — inspect title, URL, visible text, viewport, and clickable/focusable selectors
- `chrome_navigate` — navigate an existing tab
- `chrome_evaluate` — evaluate JavaScript in a tab
- `chrome_click` — click by selector or coordinates
- `chrome_type` — type text, optionally focusing a selector first
- `chrome_key` — send keyboard keys
- `chrome_wait_for` — wait for a selector or expression
- `chrome_screenshot` — capture viewport screenshots to disk

These tools are especially useful for authenticated web app debugging, repro flows, admin workflows, visual checks, and inspecting local development pages without rebuilding login state.

<details>
<summary><strong>How it works (technical details)</strong></summary>

Pi starts a local bridge on `127.0.0.1:17318`. The companion Chrome extension, installed in your normal Chrome profile, polls that local bridge for commands and executes them using Chrome extension APIs.

If another Pi session is already running the bridge, additional Pi sessions automatically act as clients of that shared bridge. This lets planner/audit/worker sessions all use the same authenticated Chrome profile concurrently without fighting over the port.

This is intentionally different from CDP-based tools: the browser extension lives inside the profile you already use, so Pi can interact with existing tabs and authenticated page state.

</details>

## Security model

The companion Chrome extension runs in the Chrome profile where you install it and has broad tab/scripting permissions. Only install it from a package source you trust.

The Pi side listens on `127.0.0.1:17318` by default. Override before starting Pi with:

```bash
PI_CHROME_BRIDGE_PORT=17319 pi
```
