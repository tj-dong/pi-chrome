# pi-chrome FAQ

## Does this work with Brave / Arc / Edge / Vivaldi?

Yes. Any Chromium-based browser that supports unpacked extensions and the `chrome.debugger` API will work. The extension is named "Pi Chrome Connector" but the source is browser-agnostic. Firefox / WebKit are out of scope (different extension models).

## Will it slow my browser down?

The companion extension is idle when no Pi command is in flight. It uses Manifest V3 service worker activation, so it wakes for a request and goes back to sleep. No content script is injected globally.

## Does it work in Chrome incognito?

By default no — extensions need explicit "Allow in incognito" permission. Toggle it on `chrome://extensions` if you want pi-chrome to see incognito tabs. We don't recommend it for sensitive work.

## Will sites detect that I'm automating?

Interactive controls use Chrome's real input layer via CDP: pointer paths are humanized, key cadence has variance, and normal user-activation gates are satisfied. Some detectors check for the `chrome.debugger` API attached and Chrome will show the "Chrome is being debugged" banner.

The [`test-suite/`](../test-suite) grades browser-control behavior against common detection signals.

## Why do I see a banner saying "Pi Chrome Connector started debugging this browser"?

That's Chrome's built-in warning when an extension uses `chrome.debugger`. pi-chrome uses Chrome's input layer for interactive controls, so the banner appears while attached.

## Can a malicious page escape and access my other tabs?

No — pages cannot directly talk to extensions. Commands flow agent → local bridge (`127.0.0.1:17318`) → extension → tab. The bridge binds to loopback only and rejects browser-origin command requests, so ordinary web pages cannot use CORS to drive it.

Chrome control is also locked per Pi session until you run `/chrome authorize`; `/chrome revoke` locks it again. The remaining risk surface is **other local processes running as you** that can connect to loopback and imitate Pi. If that's in your threat model, run pi-chrome in a separate OS user account.

## Can multiple Pi sessions use it at once?

Yes. The first session opens the local bridge; later sessions detect it and pipe their commands through the same bridge. Each Pi session must be authorized with `/chrome authorize` before its chrome_* tools work.

## Why can't this be on the Chrome Web Store?

Web Store extensions cannot communicate with a local process bridge controlled by another tool — Google's policy. pi-chrome must ship as an unpacked extension you load yourself. The upside: you can read the source. The downside: each Chrome update may prompt you to re-confirm.

## What happens when I update pi-chrome?

`/chrome doctor` will warn you if the loaded extension is older than the installed `pi-chrome`. Reload it from `chrome://extensions` to pick up the new version. Updates that add Chrome permissions may require re-approval once.

## What's the install footprint?

- Pi side: one extension that registers ~20 tools and a few slash commands.
- Chrome side: one unpacked extension, ~5000 LOC of plain JavaScript, no dependencies.

## Can I script it without Pi?

The Pi-facing tools are thin wrappers around an HTTP bridge at `127.0.0.1:17318`. You could call it directly from any process, but the API is internal and may change. If you need a stable scripting interface, file an issue and we'll consider stabilizing.

## Does `chrome_evaluate` work on strict-CSP pages?

Not always. `chrome_evaluate` and `chrome_snapshot` run in the page's MAIN world through the Function constructor, so pages whose CSP blocks `'unsafe-eval'` can reject them. `chrome_screenshot`, `chrome_navigate`, tab tools, and real Chrome input still work because they use extension/browser APIs rather than page JavaScript.

## Why does my click return `pageMutated=false`?

Either:
- The element was occluded (look for `occludedBy: <selector>` in the envelope).
- The click handler called `event.preventDefault()` and the page intentionally ignored it.
- The target changed after your snapshot; take a fresh snapshot or screenshot.

The result envelope tells you which one. **Don't blind-retry.**

## Why does `chrome_type` return `valueMatches=false`?

The field rejected or transformed the typed value. Common culprits: contenteditable rich-text editors, native date pickers, masked-input libraries, or masks. Try `chrome_fill`, then verify with `includeSnapshot=true`.

## How do I attach a file to a React file input?

`chrome_upload_file` — uses Chrome DevTools file-input control and fires `input` + `change` events. It does **not** open the native file picker. Works with React/Vue/Angular controlled inputs.

## Can it record videos?

Not yet. Screenshots only. Video recording is on the roadmap.

## How do I file a good bug report?

Include `/chrome doctor` output, the exact tool call, and the result envelope. If the page is public, link to it; if private, distill it into a benchmark page under `test-suite/challenges/`. See [CONTRIBUTING.md](../CONTRIBUTING.md).
