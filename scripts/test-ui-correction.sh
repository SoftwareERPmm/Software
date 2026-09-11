#!/bin/bash
# Correcting an order, driven through the screen a person actually uses.
#
#   npm run build && npm start &
#   npm run test:ui
#
# The posting suites prove the engine: amending an order reverses the old
# version, posts the next, and carries its invoices along. None of them opens
# the dialog, so every fault in it — a button that does nothing, a preview
# showing a figure the confirmation does not post, a correction that lands the
# reader back on the version it just retired — has been found by somebody
# looking. This walks the three steps and checks what the page says at each.
#
# Two things learned the hard way, kept here so the next person does not:
#
#   A number input is a `spinbutton`, not a textbox.
#
#   `playwright-cli fill` does not stick on these inputs — React keeps its own
#   idea of the value and the field snaps back, leaving "Preview" disabled and
#   every later step failing for a reason that looks like something else.
#   Clicking, selecting all and typing does stick, and is what a person does.
#
# It reads pages as text. A snapshot cannot see two buttons on top of each
# other, so this does not replace looking at the thing.
set -u
BASE="${1:-http://localhost:3000}"
SEED=".playwright-cli/seed.json"
bad=0

pass() { printf '  PASS  %s%s\n' "$1" "${2:+  $2}"; }
fail() { bad=$((bad+1)); printf '  FAIL  %s%s\n' "$1" "${2:+  $2}"; }

# Is this text on the page now?
has() { playwright-cli find "$1" 2>&1 | grep -q "^Found"; }

# Is it there within N seconds? The preview posts the correction and rolls it
# back, so it is a real round trip and a fixed sleep is either flaky or slow.
wait_for() {
  local text="$1" secs="${2:-30}" i=0
  while [ "$i" -lt "$secs" ]; do
    has "$text" && return 0
    sleep 1; i=$((i+1))
  done
  return 1
}

# The ref of a control by its accessible name. Roles are listed rather than
# matched loosely: "button" is a substring of "spinbutton", which matches the
# right thing by accident until the day it matches the wrong one.
ref_of() {
  playwright-cli find "$1" 2>&1 \
    | grep -oE "(button|link|textbox|spinbutton|checkbox|combobox) \"[^\"]*$1[^\"]*\" \[(disabled\] \[)?ref=[a-z0-9]+\]" \
    | grep -oE 'ref=[a-z0-9]+' | head -1 | cut -d= -f2
}

# Replace what is in a field, the way a person would.
set_field() {
  playwright-cli click "$1" >/dev/null 2>&1
  playwright-cli press "ControlOrMeta+a" >/dev/null 2>&1
  playwright-cli type "$2" >/dev/null 2>&1
}

[ -f "$SEED" ] || { echo "  no seed — run: npx tsx scripts/seed-correction-flow.mjs"; exit 1; }
ORDER_ID=$(grep -oE '"orderId": *"[^"]+"' "$SEED" | cut -d'"' -f4)
ORDER_NO=$(grep -oE '"orderNo": *"[^"]+"' "$SEED" | cut -d'"' -f4)
INVOICE_NO=$(grep -oE '"invoiceNo": *"[^"]+"' "$SEED" | cut -d'"' -f4)

echo
echo "  correcting $ORDER_NO through the screen, with $INVOICE_NO built on it"
echo

playwright-cli goto "$BASE/documents/$ORDER_ID" >/dev/null 2>&1
has "$ORDER_NO" && pass "the order opens" "$ORDER_NO" || fail "the order opens"

# ---- the dialog ----------------------------------------------------------
BTN=$(ref_of "Correct order")
if [ -z "$BTN" ]; then fail "a posted order offers to be corrected"; else
  pass "a posted order offers to be corrected"
  playwright-cli click "$BTN" >/dev/null 2>&1
  wait_for "should have said" 10 \
    && pass "  it opens on the edit step" || fail "  it opens on the edit step"
fi

# Nothing typed yet, so there is nothing to preview.
playwright-cli find "Preview the change" 2>&1 | grep -q "disabled" \
  && pass "  previewing is refused until something changes" \
  || fail "  previewing is refused until something changes"

# ---- the preview, before anything moves ----------------------------------
PRICE=$(ref_of "Unit price of")
REASON=$(ref_of "Why")
if [ -z "$PRICE" ] || [ -z "$REASON" ]; then
  fail "the price and the reason can be filled" "price=${PRICE:-none} reason=${REASON:-none}"
else
  pass "the price and the reason can be filled"
  set_field "$PRICE" "1200"
  set_field "$REASON" "agreed 1,200 with the customer"
fi

PREVIEW=$(ref_of "Preview the change")
if [ -z "$PREVIEW" ]; then fail "previewing opens once the price changes"; else
  pass "previewing opens once the price changes"
  playwright-cli click "$PREVIEW" >/dev/null 2>&1
  if wait_for "Nothing has changed yet" 45; then
    pass "  the preview says nothing has happened yet"
    has "$INVOICE_NO" \
      && pass "  and names the invoice that would follow" "$INVOICE_NO" \
      || fail "  and names the invoice that would follow" "$INVOICE_NO"
    has "12,000" && pass "  showing what each becomes" "10,000 → 12,000" \
      || fail "  showing what each becomes"
  else
    fail "  the preview says nothing has happened yet" "timed out"
  fi
fi

# ---- confirm, and land on the version that stands ------------------------
CONFIRM=$(ref_of "Confirm")
if [ -z "$CONFIRM" ]; then fail "the correction can be confirmed"; else
  pass "the correction can be confirmed"
  playwright-cli click "$CONFIRM" >/dev/null 2>&1
  if wait_for "Edited" 60; then
    pass "  the order says it was edited"
    has "Corrected" && pass "  with the reason in its version trail" \
      || fail "  with the reason in its version trail"
    has "12,000" && pass "  at the corrected figure" "12,000" \
      || fail "  at the corrected figure"
  else
    fail "  the order says it was edited" "timed out"
  fi
fi

echo
if [ "$bad" -eq 0 ]; then
  echo "  the correction works through the screen, not only through the engine"
else
  echo "  $bad FAILED"
fi
exit $([ "$bad" -eq 0 ] && echo 0 || echo 1)
