# pi-chrome 0.7.0 → 0.8.0 rebuild

Scoped to Tier 1 (bugs + diagnostics), Tier 2 (surface gaps), Tier 5.1 (version
drift), and Tier 6 (primer) from the design plan. Tier 3 (CDP backend), Tier 4
(multi-session reliability), and Tier 5.2/5.3 (auto-reload + Web Store) are
deferred.

## What changed

### T1.1 — `chrome_evaluate` returning `null` (root cause fixed)

`page.evaluate` no longer goes through the `executeInTab` helper-source
re-eval pipeline. A dedicated `evaluateInTab` path compiles the expression via
`new Function(...)` directly in MAIN world, with a syntax-error fallback that
re-compiles in statement-mode so multi-statement bodies still work. Special
return values (`undefined`, errors, symbols, bigints, functions) are surfaced
via a tagged envelope so the Node side can return them faithfully.

Verified live:
- `chrome_evaluate("1+1")` → `2`
- `chrome_evaluate("Promise.resolve(99)")` → `99`
- `chrome_evaluate("(()=>{throw new Error('x')})()")` → throws `Error: x`
- `chrome_evaluate("document.body.innerHTML = '<...>'; return 'ok'")` → `"ok"`

### T1.2 — Truthful click/type/fill results

Every action handler now returns `isTrusted: false`,
`defaultPrevented`, `elementVisible`, `occludedBy`, `valueMatches`, and
`pageMutated`. The Node side formats those into the tool result text so the
agent can read failure cause from a single response.

Verified live:
- `chrome_click(occluded-button)` → `"Clicked el-3 — pageMutated=false; occluded by <div#overlay>"`
- `chrome_click(working-button)` → `"Clicked el-1"` (silent on success)

### T1.3 — `/chrome-doctor` extended

The command now probes:
- Local bridge mode + URL
- Companion extension version (with mismatch warning vs `PI_CHROME_VERSION`)
- `chrome_evaluate("1+1") === 2` in the active tab
- MAIN-world helper injection via `page.probe`, including `navigator.webdriver` fingerprint
- CDP availability at `127.0.0.1:9222` (informational; not used yet)

### T1.4 — Misleading params removed/implemented

- Dropped `chrome_evaluate.returnByValue` (was ignored).
- Implemented `chrome_screenshot.fullPage` via tile stitching (see T2.2).

### T1.5 — Autoplay-gate heuristic

`clickPage` checks whether the clicked element's label looks media-related
(`/^(play|start|begin|next|continue|unmute)/`) AND the page has paused
`<audio>`/`<video>`. If both, the result includes an `autoplayHint` that surfaces
to the agent: "synthetic click may not start media".

Verified live: clicking `<button aria-label="Play">` with a paused `<audio>`
returns `autoplay-gated affordance — synthetic click may not start media`.

### T2.1 — New input tools

- `chrome_hover(uid|selector|x,y)` — dispatches pointerover/mouseover/pointerenter/mouseenter/pointermove/mousemove.
- `chrome_drag(from*, to*, steps?)` — pointerdown at A, N pointermoves, pointerup at B. Note in tool description that HTML5 `DataTransfer` is NOT synthesized so native drag-and-drop targets may not respond.
- `chrome_upload_file(uid|selector, paths[])` — reads files from disk, populates `<input type=file>` via `DataTransfer`, dispatches input+change.

Verified live (via direct bridge HTTP since the running pi session was loaded
before these tools were registered):
- hover → `defaultPrevented=false`
- drag from src to dst → `pointerdown` on src and `pointerup` on dst fired; result `pageMutated=true`
- upload with base64 of `hello world` → input.files has 1 file, name and size match

### T2.2 — Full-page screenshots

`chrome_screenshot({fullPage:true})` now records page dimensions, scrolls
through the page in viewport-sized increments, captures one tile per scroll
position via `chrome.tabs.captureVisibleTab`, restores scrollY, and returns an
array of `{y, dataUrl}`. The Node side writes each tile to disk with a
`-tileN.png` suffix and a `.json` manifest listing dimensions and tile y
offsets. (Cross-platform PNG stitching would need an image library; the
manifest format lets the caller stitch with `sips`, `montage`, `pillow`, etc.)

Verified live: Wikipedia article → 2 tiles, dimensions captured (`width: 1263, height: 919, dpr: 2`).

### T2.3 — `chrome_navigate.initScript`

Added optional `initScript` parameter on `chrome_navigate`. The script is run
in MAIN world at `webNavigation.onCommitted` of the next navigation in that
tab, before page scripts execute. Requires the new `webNavigation`
permission (added to manifest).

Verified live: navigated to `https://example.com` with
`initScript: "window.__PI_INIT_FIRED__ = Date.now()"`. After load, the global
was set ~3.5s before `Date.now()` — confirming it fired at document_start, not
post-load.

### T2.5 — Snapshot filters + extra signals

`chrome_snapshot` accepts:
- `containingText` — case-insensitive substring filter on the element label
- `roleFilter` — exact match on `role` attribute OR tag name
- `nearUid` — sort elements by distance to a previously snapshotted element

Each element now includes:
- `inert: true` when inside an `[inert]` ancestor
- `pointerEvents` from computed style
- `occluded: {tag, id, className}` if `document.elementFromPoint(center)` returns a different element (and not a descendant/ancestor)

Verified live:
- `containingText:"hidden"` returned only the matching button
- `roleFilter:"button"` returned only buttons
- `nearUid:el-anchor` correctly ordered anchor → near → far by pixel distance
- Occluded button (covered by full-viewport `div#overlay`) reported `occluded: {tag:"div", id:"overlay"}`

### T5.1 — Version drift warning

`/chrome-doctor` already flags version drift between the loaded extension and
`PI_CHROME_VERSION`. Per-tool-call drift warnings deferred to a future pass
(needs every chrome_* response to include extension version, which costs an
extra wire round trip or piggyback header). Bumped version to **0.8.0**.

### T6 — Primer rewritten

The `before_agent_start` primer now spells out:
- All input is synthetic (`isTrusted=false`)
- Audio/clipboard/file-picker gates won't work
- Tool results include `pageMutated`, `defaultPrevented`, `elementVisible`, `occludedBy`, `valueMatches` and what to do with them
- `chrome_evaluate` returning null means the expression evaluated to null in the page
- `chrome_navigate.initScript` is available
- `/chrome-doctor` for capability check

### Other touch-ups

- `chrome_navigate` timeout now adds 2s slack on top of `timeoutMs` to allow the wire round trip.
- Snapshot's candidate query now includes `[role=menuitem]`, `[role=tab]`, `[role=checkbox]`.
- `page.waitFor` `expression` mode no longer uses indirect `eval` (uses `Function` constructor for CSP-safe evaluation).

## Files touched

- `extensions/chrome-profile-bridge/index.ts` — bump version, primer, doctor probes, truthful tool result text, new tool registrations, full-page screenshot stitching.
- `extensions/chrome-profile-bridge/browser-extension/service_worker.js` — rewritten evaluate path, snapshot filters/flags, click/type/fill instrumentation, hover/drag/upload/probe handlers, full-page screenshot tile plan, initScript dispatcher.
- `extensions/chrome-profile-bridge/browser-extension/manifest.json` — bump version, add `webNavigation` permission.
- `package.json` — bump version.

## What's deferred (Tier 3 / 4 / 5.x)

- **CDP backend** (`chrome_trusted_*`): not implemented. Requires `puppeteer-core` dep and reconciling CDP target IDs with extension tab IDs. `/chrome-doctor` reports whether `127.0.0.1:9222` is reachable so a future pass can light this up.
- **Multi-session handover / tab leasing**: not changed.
- **Extension auto-reload on version drift / Web Store distribution**: not changed.

## To unblock the next pi session

The currently-running pi session has the **old** `index.ts` registered (Pi loads
extensions at startup). To get the new tool surface (`chrome_hover`,
`chrome_drag`, `chrome_upload_file`, new `chrome_doctor`, new primer, new
truthful click results):

1. **Restart this pi session.** (The workspace symlink + global install are
   both already updated to 0.8.0.)
2. The Chrome extension at `chrome://extensions` is **already reloaded** to
   0.8.0 (you did that during this session).
3. Run `/chrome-doctor` in the new session — expect 5 green checks.

## Acceptance test results

| Test | Result |
|------|--------|
| `chrome_evaluate("1+1")` returns `2` | ✓ |
| `chrome_evaluate(promise)` resolves | ✓ |
| `chrome_evaluate` statement-mode fallback | ✓ |
| `chrome_evaluate` rethrows errors | ✓ |
| `chrome_evaluate(undefined)` doesn't crash | ✓ |
| `chrome_click` reports `pageMutated=false; occluded by` for covered buttons | ✓ |
| `chrome_click` clean success has no warning suffix | ✓ |
| `chrome_click` autoplay heuristic fires on `<button aria-label=Play>` w/ paused audio | ✓ |
| `chrome_snapshot.containingText` filters correctly | ✓ |
| `chrome_snapshot.roleFilter` filters correctly | ✓ |
| `chrome_snapshot.nearUid` sorts by distance | ✓ |
| `chrome_snapshot` reports `occluded` and `inert` and `pointerEvents` | ✓ |
| `page.hover` dispatches | ✓ |
| `page.drag` produces real pointerdown/up events on src/dst | ✓ |
| `page.upload` populates input.files with correct name/size | ✓ |
| `page.navigate` with `initScript` runs at document_start | ✓ |
| `page.screenshot` `fullPage` produces correct tile count | ✓ |
| `page.probe` returns MAIN-world arithmetic and webdriver flag | ✓ |
| CDP 9222 probe reports correctly when not reachable | ✓ |
