# pi-chrome browser-control benchmark

Static benchmark pages for evaluating tools that let agents control Chrome. The
suite covers two related questions:

1. **Can the agent complete normal browser work?** Forms, scroll containers,
   contenteditable, files, frames, Shadow DOM, network/console inspection.
2. **Does the interaction look like a human/browser action when sites care?**
   `isTrusted`, user activation, pointer paths, key cadence, native controls,
   drag/drop, touch, paste, and scroll momentum.

## Run

```bash
cd test-suite
python3 -m http.server 8765
# open http://127.0.0.1:8765/ in the Chrome window pi-chrome controls
```

Each challenge page exposes:

- `window.__challenge` — id
- `window.__verdict` — `"PENDING" | "PASS" | "FAIL" | "SKIP" | "WARN"`
- `window.__reason` — array of reasons
- `window.__events` — raw event log for forensics

`manifest.json` is the source of truth for benchmark metadata: category, goal,
expected result per mode, prerequisites, flake risk, manual baseline status, and
canonical tool recipe. `manifest.schema.json` documents the manifest shape.
Recipes express tool intent; runners may need to adapt descriptive selectors
(e.g. shadow/iframe notation) and expand path placeholders like `$PWD`.

## Modes / expected outcomes

The same page can have different expected results depending on tool capability:

- `synthetic` — DOM-dispatched events / framework-aware setters. Fast and quiet.
- `trusted` — browser-trusted input, usually via `chrome.debugger`/CDP. Can show
  Chrome's debugging banner.
- `manual` — human baseline in same browser/profile.

Expected values in `manifest.json`:

- `PASS` / `FAIL` — deterministic target for that mode.
- `CONDITIONAL` — depends on browser policy, OS, device capability, permissions,
  or an unreleased tool primitive. Inspect `prerequisites`, `notes`, and
  `flakeRisk`.

Manual baselines are tracked separately with `manualBaseline`. `unverified`
means the manual expectation is a target, not a recorded contract.

## Recommended agent flow

1. Navigate to dashboard:
   `http://127.0.0.1:8765/`.
2. Pick mode (`synthetic`, `trusted`, or `manual`) and clear local verdicts.
3. For each manifest row:
   - `chrome_navigate` to `http://127.0.0.1:8765/<file>`.
   - `chrome_snapshot` before acting; prefer snapshot `uid` over raw selector.
   - Execute the listed `recipe`, adapting descriptive frame/shadow selectors to
     whatever selectors/uids the tool exposes.
   - Read:
     ```js
     JSON.stringify({
       v: window.__verdict,
       r: window.__reason,
       e: window.__events?.slice(-20)
     })
     ```
4. Return to dashboard and compare actual verdicts with expected values.
5. Copy JSON report from dashboard for PRs or regression notes.

## Challenge categories

- `trusted-input` — browser-trusted click/key events.
- `pointer-humanization` — paths, coordinates, movement continuity/rate.
- `keyboard` / `focus-keyboard` — typing fidelity, modifiers, Tab flows.
- `activation-gates` — clipboard/fullscreen/user activation.
- `scroll` / `scroll-visibility` — wheel events, momentum, IntersectionObserver.
- `drag-drop` — HTML5 drag/drop + `DataTransfer`.
- `clipboard` — OS/browser paste path.
- `native-controls` — controls that should use browser UI/keyboard semantics.
- `frameworks` / `editing` — React-style value tracking, contenteditable.
- `dom-complexity` / `frames` — Shadow DOM and iframe targeting.
- `files` — file attachment to `<input type=file>`.
- `observability` — console/network capture tools.
- `fingerprint` — environment and stack fingerprint probes.
- `agent-safety` — hidden honeypots and safe target selection.

## Current challenge inventory

The dashboard renders this from `manifest.json`. In brief:

1. trusted click
2. trusted keyboard
3. webdriver/runtime flags
4. mouse entropy before click
5. click timing
6. click coordinate variation
7. pointer event properties
8. keyboard cadence
9. beforeinput/input order
10. user activation gates
11. honeypot safety
12. fingerprint consistency
13. focus order
14. wheel scroll
15. drag/drop `DataTransfer`
16. contenteditable selection
17. paste clipboard
18. native select
19. hover dwell
20. React value tracker
21. keyboard modifiers
22. touch events
23. stack trace fingerprint
24. viewport click coordinates
25. pointer continuity
26. mousemove rate
27. scroll momentum
28. intersection visibility
29. Shadow DOM controls
30. iframe targeting
31. file upload
32. keyboard Tab navigation
33. network/console capture

## Design notes

- A failure is useful only when compared to expected mode. Example: synthetic
  `isTrusted` failing is expected and validates that the test detects quiet DOM
  events.
- Some tests are capability-gated. Example: touch tests should be `SKIP`/manual
  conditional on non-touch hardware.
- Fingerprint tests should warn before blocking. Real Chrome profiles can use
  software WebGL in VMs, remote desktops, or policy-constrained environments.
- `notes/bypass-ideas.md` is historical guidance for older synthetic-only
  versions. Prefer `manifest.json` for current expected outcomes.
