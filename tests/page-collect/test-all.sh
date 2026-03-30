#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COLLECT="$REPO_ROOT/skills/page-collect/scripts/page-collect.js"
FIXTURES="$SCRIPT_DIR/fixtures"
OUTPUT="/tmp/page-collect-all-test-$$"
PASS=0
FAIL=0

cleanup() { rm -rf "$OUTPUT"; }
trap cleanup EXIT

assert_file_exists() {
  if [[ -f "$1" ]]; then
    ((++PASS))
  else
    echo "FAIL: expected file $1"
    ((++FAIL))
  fi
}

assert_dir_exists() {
  if [[ -d "$1" ]]; then
    ((++PASS))
  else
    echo "FAIL: expected directory $1"
    ((++FAIL))
  fi
}

echo "=== Test: all subcommand against mixed-icons fixture ==="
node "$COLLECT" all "file://$FIXTURES/mixed-icons.html" --output "$OUTPUT" 2>/dev/null

assert_file_exists "$OUTPUT/collection.json"
assert_file_exists "$OUTPUT/screenshot.jpg"
assert_dir_exists "$OUTPUT/icons"
assert_file_exists "$OUTPUT/icons.json"

node -e "
  import {readFileSync} from 'fs';
  const d = JSON.parse(readFileSync('$OUTPUT/collection.json','utf-8'));
  const expected = ['icons','metadata','text','forms','videos','socials'];
  const missing = expected.filter(k => !(k in d.collectors));
  if (missing.length) { console.error('Missing:', missing); process.exit(1); }
  if (!d.url) { console.error('Missing url'); process.exit(1); }
  if (!d.collectedAt) { console.error('Missing collectedAt'); process.exit(1); }
" && ((++PASS)) || { echo "FAIL: collection.json schema"; ((++FAIL)); }

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ "$FAIL" -eq 0 ]]
