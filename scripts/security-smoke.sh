#!/usr/bin/env bash
#
# Negative-path smoke tests for the hardened pi-chrome bridge.
#
# Run against a live bridge (Pi session must be running with this pi-chrome version).
# These tests do NOT require an extension to be paired; they assert that unauthenticated
# callers cannot drive Chrome through the bridge.
#
# usage: ./scripts/security-smoke.sh
#
# Each test is independent. Failures print FAIL and a non-zero exit at the end.

set -u

BRIDGE_URL="${PI_CHROME_BRIDGE_URL:-http://127.0.0.1:17318}"
FAILED=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1  (got: $2)"; FAILED=$((FAILED+1)); }

check_status() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then pass "$desc"; else fail "$desc — expected HTTP $expected" "$actual"; fi
}

http_status() {
  curl -sS -o /dev/null -w "%{http_code}" "$@"
}

echo "Bridge URL: $BRIDGE_URL"

# 1. /command without auth header -> 401 (broker auth required)
status=$(http_status -X POST "$BRIDGE_URL/command" -H 'content-type: application/json' --data '{"action":"tab.list","params":{}}')
check_status "/command without auth -> 401" 401 "$status"

# 2. /next from random chrome-extension origin returns 200 idle and never delivers a command.
#    Until the bridge is paired, the response includes {"needsPairing":true}. After pairing,
#    a non-pinned origin still gets the same idle payload (never the queued command). Either
#    way: type=none, no commands.
body=$(curl -sS -H 'Origin: chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' "$BRIDGE_URL/next?name=smoke")
if echo "$body" | grep -q '"type":"none"' && ! echo "$body" | grep -q '"type":"command"'; then
  pass "/next from unpinned chrome-extension origin is idle, never command"
else
  fail "/next from unpinned chrome-extension origin" "$body"
fi

# 3. /next with wrong-shaped Origin (real web origin) -> 403
status=$(http_status -H 'Origin: https://example.com' "$BRIDGE_URL/next")
check_status "/next from web origin -> 403" 403 "$status"

# 4. Oversized body to /command -> 413. Stream via stdin so argv stays sane on macOS.
status=$(head -c $((2*1024*1024)) /dev/zero | tr '\0' 'x' \
  | curl -sS -o /dev/null -w "%{http_code}" -X POST "$BRIDGE_URL/command" \
      -H 'content-type: application/json' --data-binary @-)
check_status "/command oversized body -> 413" 413 "$status"

# 5. Malformed JSON to /result without auth: must be rejected (401/403) and must not crash
#    the server. Verify by hitting /status afterwards.
status=$(http_status -X POST "$BRIDGE_URL/result" \
  -H 'content-type: application/json' \
  -H 'Origin: chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
  --data 'not json')
case "$status" in
  401|403) pass "/result malformed JSON without auth rejected ($status)";;
  *) fail "/result malformed JSON without auth" "$status";;
esac
# Confirm server stayed responsive after the parse-error attempt.
status=$(http_status "$BRIDGE_URL/status")
check_status "/status still responsive after malformed POST" 200 "$status"

# 6. /status is OK (loopback only, no secrets) -> 200
status=$(http_status "$BRIDGE_URL/status")
check_status "/status -> 200" 200 "$status"

# 7. /command with bogus auth header -> 401
status=$(http_status -X POST "$BRIDGE_URL/command" \
  -H 'content-type: application/json' \
  -H 'x-pi-chrome-auth: v1 ts=1 nonce=AAAA sig=AAAA' \
  --data '{"action":"tab.list","params":{}}')
check_status "/command with bogus auth -> 401" 401 "$status"

# 8. /pair without active pairing window -> 403
status=$(http_status -X POST "$BRIDGE_URL/pair" \
  -H 'content-type: application/json' \
  -H 'Origin: chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
  --data '{"extensionId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","extensionNonce":"AAAA","mac":"AAAA"}')
case "$status" in
  401|403) pass "/pair without active window rejected ($status)";;
  *) fail "/pair without active window" "$status";;
esac

echo
if [[ $FAILED -eq 0 ]]; then
  echo "ALL SMOKE TESTS PASSED"
  exit 0
else
  echo "$FAILED test(s) failed"
  exit 1
fi
