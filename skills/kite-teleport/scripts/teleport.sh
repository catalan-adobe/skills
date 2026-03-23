#!/bin/bash
set -euo pipefail

if [ "${1:-}" = "--stdin" ]; then
  read -r TOKEN
  CWD="${2:-$(pwd)}"
else
  TOKEN="${1:?Usage: teleport.sh <token> [cwd] or echo token | teleport.sh --stdin [cwd]}"
  CWD="${2:-$(pwd)}"
fi

if ! [[ "$TOKEN" =~ ^kt_[0-9a-f]{8}$ ]]; then
  echo "ERROR: invalid token format (expected kt_XXXXXXXX)" >&2
  exit 1
fi
if [ -z "${KITE_WORKER_URL:-}" ]; then
  echo "ERROR: KITE_WORKER_URL not set. Export it before running." >&2
  exit 1
fi
WORKER_URL="${KITE_WORKER_URL}"
TMPFILE="/tmp/kite-teleport-$$.json"

trap 'rm -f "$TMPFILE"' EXIT

HTTP_CODE=$(curl -s -w "%{http_code}" \
  "${WORKER_URL}/teleport/${TOKEN}?format=claude-code&cwd=${CWD}" \
  -o "$TMPFILE")

if [ "$HTTP_CODE" != "200" ]; then
  echo "ERROR: worker returned HTTP ${HTTP_CODE}"
  cat "$TMPFILE"
  exit 1
fi

# Use node to parse, validate, and place the session
node -e "
  const fs = require('fs');
  const os = require('os');
  const d = JSON.parse(fs.readFileSync('${TMPFILE}', 'utf8'));

  // Validate sessionId: alphanumeric + hyphens only (no path traversal)
  if (!/^[a-zA-Z0-9_-]+$/.test(d.sessionId)) {
    console.error('ERROR: invalid sessionId format from worker');
    process.exit(1);
  }
  if (typeof d.session !== 'string' || !d.session.trim()) {
    console.error('ERROR: empty or missing session data from worker');
    process.exit(1);
  }

  const encodedCwd = '${CWD}'.replace(/[^a-zA-Z0-9]/g, '-');
  const dir = os.homedir() + '/.claude/projects/' + encodedCwd;
  fs.mkdirSync(dir, { recursive: true });
  const outPath = dir + '/' + d.sessionId + '.jsonl';
  fs.writeFileSync(outPath, d.session);
  const lines = d.session.split('\n').filter(Boolean).length;
  console.log(JSON.stringify({
    sessionId: d.sessionId,
    repo: d.repo,
    branch: d.branch,
    records: lines,
    file: outPath,
  }));
"
