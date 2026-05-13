# pi-chrome examples

Real, useful agent prompts. Drop any of these into Pi after running `/chrome onboard`. Each one uses Chrome tabs and accounts you already have.

## Daily workflow

### PR triage

```text
Use chrome_tab list to find my GitHub notifications tab.
chrome_snapshot it. Group PRs by:
  - awaiting my review
  - blocked on me (changes requested back)
  - mergeable (approved + green CI)
Output a 5-bullet ranked triage. Do not click anything.
```

### Linear standup

```text
Open my Linear current cycle in the active tab.
chrome_snapshot, then write yesterday/today/blockers
in the exact format my standup channel uses.
```

### Slack catch-up

```text
For each unread channel in my Slack tab, chrome_snapshot,
extract the top 3 messages that mention me or my team,
and summarize what I missed in <100 words total.
```

## Debugging

### Reproduce a customer bug with evidence

```text
1. chrome_navigate to https://staging.acme.com/orders/<id>
2. chrome_snapshot
3. Click "Refund" with chrome_click
4. Use chrome_list_network_requests to capture the API call
5. chrome_get_network_request on the failing one — give me the response body
6. chrome_screenshot the error state to ./repro/refund-bug.png
```

### Visual diff local vs staging

```text
chrome_screenshot http://localhost:3000/pricing → ./diff/local.png
chrome_screenshot https://staging.acme.com/pricing → ./diff/staging.png
Then read both, describe layout differences in plain English.
```

### Console + network forensics

```text
Reproduce the checkout bug on the active tab.
After the failure:
  - chrome_list_console_messages
  - chrome_list_network_requests
Cross-reference the timestamps and tell me what broke first.
```

## Admin / ops

### Multi-tab cross-check

```text
I have Stripe, Postmark, and our internal admin open in 3 tabs.
For user <id>, chrome_snapshot each tab in turn and find
any field where state disagrees. Output a 3-column table.
```

### Bulk gentle action (safe form-fill, no submit)

```text
Open our vendor portal "Add Vendor" form.
For each row in ./vendors.csv:
  - chrome_fill the form
  - chrome_screenshot it
  - STOP before submit
  - chrome_evaluate "history.back()" to return to the list
I will review screenshots and submit manually.
```

### Auth-only data pull

```text
My analytics dashboard is open and the cookie auth would die in headless mode.
chrome_evaluate to read window.__APP_STATE__.dashboardData
and dump today's KPIs as JSON.
```

## Demos / PRs

### Capture screenshots for a PR description

```text
On localhost:3000/feature-x:
  - empty state → ./pr/01-empty.png
  - filled state → ./pr/02-filled.png
  - error state (delete the API key from devtools first) → ./pr/03-error.png
Save each with chrome_screenshot. Output a markdown block I can paste into the PR.
```

### Record a guided demo flow

```text
On my staging app:
1. Walk the new-onboarding flow start to finish
2. After each chrome_click or chrome_navigate, chrome_screenshot
3. Save numbered PNGs under ./demo/
4. Write narration captions for each step
```

## Forms with frameworks

### React controlled inputs

```text
chrome_fill (not chrome_type) for React inputs — it uses the
framework-aware native value setter so the form's state actually updates.
After each fill, the result envelope's valueMatches=true confirms the
component re-rendered with the new value.
```

### File upload without the native picker

```text
chrome_upload_file paths=[./fixtures/avatar.png] selector="input[type=file]"
# No native file picker opens. Works with React/Vue/Angular controlled inputs.
```

### Drag-to-reorder lists

```text
chrome_drag fromUid=row-3 toUid=row-1
# Fires real HTML5 dragstart/dragover/drop with a shared DataTransfer.
```

## Multi-session patterns

`pi-chrome` shares one bridge across all Pi sessions on the same machine. Useful patterns:

### Planner + Worker

- **Planner session** stays high level: "find the bug, decide the fix."
- **Worker session** runs the actual `chrome_*` tools.
- Both see the same Chrome state because they're both pointing at your real profile.

### Watcher

A third Pi session can run `chrome_snapshot` periodically in `background: true` mode and post summaries via `pi-qq` — handy for long-running flows.

## When to prefer trusted clicks

Pass `trusted: true` on `chrome_click` (or run `/chrome clicks on`) when:

- the click should open a file picker
- the click should write to the clipboard or read it
- the click should start an audio/video play
- the click should request fullscreen / push permission
- the page is wrapped in a strict user-activation guard (some paywalls / login flows)

Everything else is faster and quieter without it.
