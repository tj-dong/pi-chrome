# Recipe runner spec

Future Node/Pi runner should:

1. Read `manifest.json`.
2. Probe environment capabilities (`trusted`, `clipboard`, `touch`, `dialogs`, `downloads`, `fileSystem`).
3. For each entry:
   - skip if `requires` is unsatisfied and expected is `CONDITIONAL`
   - navigate to challenge URL
   - execute `recipe` in order
   - wait `verdictDelayMs || 500`
   - evaluate `JSON.stringify({v:window.__verdict,r:window.__reason,d:window.Challenge?.state?.details,e:window.__events?.slice(-20)})`
   - compare to `expected[mode]`
4. Output:
   - Markdown summary
   - JSON details
   - JUnit XML for CI

Runner must adapt recipe intent:

- expand `${REPO_ROOT}` path placeholders
- adapt unsupported shadow/iframe selector notation to snapshot uids or evaluate fallback
- preserve hook install ordering for console/network capture tests
- record whether trusted/CDP path was used

Long-horizon task runner should read `task-manifest.json`, replace `$RUN_ID`, solve task, then evaluate task grader expression.
