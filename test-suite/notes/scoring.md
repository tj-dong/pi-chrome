# Benchmark scoring

## Unit challenges (`manifest.json`)

Score actual verdict against `expected[mode]`, not raw PASS count.

- `PASS` / `FAIL` expected: exact match required.
- `CONDITIONAL`: exclude from headline score unless environment prerequisite is declared present.
- `SKIP` / `WARN`: report separately.

Recommended flake policy:

- Run each non-destructive challenge up to 2 retries.
- Take best verdict only for known-flaky timing/scroll tests.
- Always keep all reasons/events in detailed report.

Difficulty weighting:

- L1 = 1
- L2 = 2
- L3 = 3

Report both unweighted and weighted score. Also report per-category score.

## Long-horizon tasks (`task-manifest.json`)

Task score is deterministic grader PASS / not PASS. Record:

- action count
- wall time
- tools used
- observation mode (`snapshot`, screenshot, accessibility, evaluate)
- whether direct state mutation/evaluate was allowed
- final grader reason

Do not use LLM judge for hermetic tasks unless grader cannot express the target.
