#!/bin/bash
# Every screen, opened once: does it render, and does the browser complain?
#
#   npm start &        # a production build, not next dev
#   bash scripts/smoke-ui.sh [base-url]
#
# The posting suites prove the ledger. Nothing proved the screens — every UI
# fault this project has had was found by somebody looking at it, which is a
# slow and unreliable way to find a page that throws on an empty table. This
# walks every route the app defines and reports the two things a browser can
# tell you without a human reading the page: the status it came back with, and
# what the console said on the way.
#
# Not a substitute for looking. A page can return 200, log nothing, and still
# have its buttons on top of each other.
set -u
BASE="${1:-http://localhost:3000}"
ROUTES=$(find app -name "page.tsx" | sed 's|^app||;s|/page.tsx$||;s|^$|/|' | grep -v '\[' | sort)
fail=0; n=0

for r in $ROUTES; do
  n=$((n+1))
  out=$(playwright-cli goto "$BASE$r" 2>&1)
  status=$(printf '%s' "$out" | grep -oE 'HTTP status: [0-9]+ [A-Za-z ]+' | head -1)
  console=$(printf '%s' "$out" | grep -oE '[0-9]+ errors' | head -1)
  bad=""
  case "$status" in *"200"*|"") ;; *) bad="yes" ;; esac
  case "$console" in "0 errors"|"") ;; *) bad="yes" ;; esac
  if [ -n "$bad" ]; then
    fail=$((fail+1))
    printf '  FAIL  %-34s %s %s\n' "$r" "${status:-no status}" "${console:-}"
  else
    printf '  ok    %-34s\n' "$r"
  fi
done

echo
if [ "$fail" -eq 0 ]; then
  echo "  $n screens, none erroring"
else
  echo "  $n screens, $fail with a problem"
fi
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
