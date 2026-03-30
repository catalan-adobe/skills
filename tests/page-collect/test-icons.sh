#!/bin/bash
set -euo pipefail

# Integration tests for the icon collector (collect-icons.js)
# Runs against 3 HTML fixtures and asserts on the resulting icons.json
# and individual SVG files.
#
# Exit code 0 = all tests pass, non-zero = at least one failure.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COLLECT="$REPO_ROOT/skills/page-collect/scripts/page-collect.js"
FIXTURES="$SCRIPT_DIR/fixtures"

PASS=0
FAIL=0

OUTDIR="/tmp/page-collect-test-$$"
mkdir -p "$OUTDIR"

cleanup() {
  rm -rf "$OUTDIR"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

assert() {
  local name="$1"
  local result="$2"  # "pass" or "fail"
  local detail="${3:-}"

  if [[ "$result" == "pass" ]]; then
    PASS=$((PASS + 1))
    printf "  PASS: %s\n" "$name"
  else
    FAIL=$((FAIL + 1))
    printf "  FAIL: %s%s\n" "$name" "${detail:+ ($detail)}"
  fi
}

run_collector() {
  local fixture="$1"
  local out="$2"
  local url="file://${FIXTURES}/${fixture}"
  mkdir -p "$out"
  node "$COLLECT" icons "$url" --output "$out" 2>/dev/null
}

json_count() {
  local file="$1"
  local jq_expr="$2"
  node -e "
    import { readFileSync } from 'node:fs';
    const j = JSON.parse(readFileSync('${file}', 'utf8'));
    process.stdout.write(String(${jq_expr}));
  " 2>/dev/null
}

# ---------------------------------------------------------------------------
# Fixture 1: inline-svgs.html
# ---------------------------------------------------------------------------
echo ""
echo "--- inline-svgs.html ---"

OUT1="$OUTDIR/inline"
run_collector "inline-svgs.html" "$OUT1"
MANIFEST1="$OUT1/icons.json"

# Total entries = 3 (search icon, cart icon, logo)
TOTAL1=$(json_count "$MANIFEST1" "JSON.parse(readFileSync('${MANIFEST1}','utf8')).icons.length")
assert "inline-svgs: 3 entries total" \
  "$([ "$TOTAL1" -eq 3 ] && echo pass || echo fail)" \
  "got $TOTAL1"

# No image-class entries (hero banner filtered out)
IMG_COUNT1=$(json_count "$MANIFEST1" \
  "JSON.parse(readFileSync('${MANIFEST1}','utf8')).icons.filter(i=>i.class==='image').length")
assert "inline-svgs: 0 image-class entries" \
  "$([ "$IMG_COUNT1" -eq 0 ] && echo pass || echo fail)" \
  "got $IMG_COUNT1"

# search icon exists
assert "inline-svgs: search icon present" \
  "$([ -f "$OUT1/icons/search.svg" ] && echo pass || echo fail)"

# cart icon exists
assert "inline-svgs: cart icon present" \
  "$([ -f "$OUT1/icons/cart.svg" ] && echo pass || echo fail)"

# logo entry exists (class = logo)
LOGO_COUNT1=$(json_count "$MANIFEST1" \
  "JSON.parse(readFileSync('${MANIFEST1}','utf8')).icons.filter(i=>i.class==='logo').length")
assert "inline-svgs: 1 logo entry" \
  "$([ "$LOGO_COUNT1" -eq 1 ] && echo pass || echo fail)" \
  "got $LOGO_COUNT1"

# ---------------------------------------------------------------------------
# Fixture 2: img-svgs.html
# ---------------------------------------------------------------------------
echo ""
echo "--- img-svgs.html ---"

OUT2="$OUTDIR/img"
run_collector "img-svgs.html" "$OUT2"
MANIFEST2="$OUT2/icons.json"

# Total entries = 2 (brand logo + account icon)
TOTAL2=$(json_count "$MANIFEST2" "JSON.parse(readFileSync('${MANIFEST2}','utf8')).icons.length")
assert "img-svgs: 2 entries total" \
  "$([ "$TOTAL2" -eq 2 ] && echo pass || echo fail)" \
  "got $TOTAL2"

# ---------------------------------------------------------------------------
# Fixture 3: mixed-icons.html
# ---------------------------------------------------------------------------
echo ""
echo "--- mixed-icons.html ---"

OUT3="$OUTDIR/mixed"
run_collector "mixed-icons.html" "$OUT3"
MANIFEST3="$OUT3/icons.json"

# Icon-class entries
ICON_COUNT3=$(json_count "$MANIFEST3" \
  "JSON.parse(readFileSync('${MANIFEST3}','utf8')).icons.filter(i=>i.class==='icon').length")
assert "mixed-icons: icon-class entries >= 3" \
  "$([ "$ICON_COUNT3" -ge 3 ] && echo pass || echo fail)" \
  "got $ICON_COUNT3"

# Exactly 1 logo
LOGO_COUNT3=$(json_count "$MANIFEST3" \
  "JSON.parse(readFileSync('${MANIFEST3}','utf8')).icons.filter(i=>i.class==='logo').length")
assert "mixed-icons: 1 logo entry" \
  "$([ "$LOGO_COUNT3" -eq 1 ] && echo pass || echo fail)" \
  "got $LOGO_COUNT3"

# No image-class entries (large decorative SVG filtered out)
IMG_COUNT3=$(json_count "$MANIFEST3" \
  "JSON.parse(readFileSync('${MANIFEST3}','utf8')).icons.filter(i=>i.class==='image').length")
assert "mixed-icons: 0 image-class entries" \
  "$([ "$IMG_COUNT3" -eq 0 ] && echo pass || echo fail)" \
  "got $IMG_COUNT3"

# search.svg was written
assert "mixed-icons: search.svg exists" \
  "$([ -f "$OUT3/icons/search.svg" ] && echo pass || echo fail)"

# search.svg has viewBox
if [[ -f "$OUT3/icons/search.svg" ]]; then
  assert "mixed-icons: search.svg has viewBox" \
    "$(grep -q 'viewBox' "$OUT3/icons/search.svg" && echo pass || echo fail)"

  # search.svg colors replaced with currentColor
  assert "mixed-icons: search.svg uses currentColor" \
    "$(grep -q 'currentColor' "$OUT3/icons/search.svg" && echo pass || echo fail)"

  # optimizeSvg strips width= from icons
  assert "mixed-icons: search.svg has no width= attribute" \
    "$(! grep -q ' width=' "$OUT3/icons/search.svg" && echo pass || echo fail)"
else
  assert "mixed-icons: search.svg has viewBox" "fail" "file missing"
  assert "mixed-icons: search.svg uses currentColor" "fail" "file missing"
  assert "mixed-icons: search.svg has no width= attribute" "fail" "file missing"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
TOTAL=$((PASS + FAIL))
echo "=== Results: $PASS/$TOTAL passed, $FAIL failed ==="
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
