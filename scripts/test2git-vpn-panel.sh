#!/usr/bin/env bash
# test2git adapter for this Node/TypeScript repository.
# It is non-blocking by default so every push leaves an AI-readable receipt.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
OUTPUT_DIR="$REPO_ROOT/.test2git"
RAW_OUTPUT="$OUTPUT_DIR/vpn-panel.txt"
SUMMARY="$OUTPUT_DIR/vpn-panel.json"
HISTORY="$OUTPUT_DIR/history.jsonl"

mkdir -p "$OUTPUT_DIR"

started_at="$(date --iso-8601=seconds)"
started_epoch="$(date +%s)"
commit="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
branch="$(git -C "$REPO_ROOT" branch --show-current || true)"

if (
  set +e
  printf '%s\n' '[test2git] npm test'
  (cd "$REPO_ROOT" && npm test)
  test_exit=$?
  printf '%s\n' "[test2git] npm test exit=$test_exit"
  printf '%s\n' '[test2git] npm run build'
  (cd "$REPO_ROOT" && npm run build)
  build_exit=$?
  printf '%s\n' "[test2git] npm run build exit=$build_exit"
  exit $((test_exit || build_exit))
) >"$RAW_OUTPUT" 2>&1; then
  run_exit=0
else
  run_exit=$?
fi

test_exit="$(sed -n 's/^\[test2git\] npm test exit=//p' "$RAW_OUTPUT" | tail -1)"
build_exit="$(sed -n 's/^\[test2git\] npm run build exit=//p' "$RAW_OUTPUT" | tail -1)"
test_exit="${test_exit:-1}"
build_exit="${build_exit:-1}"

ended_epoch="$(date +%s)"
duration=$((ended_epoch - started_epoch))
passed="$(awk '/^# pass [0-9]+$/ { value=$3 } END { print value + 0 }' "$RAW_OUTPUT")"
failed="$(awk '/^# fail [0-9]+$/ { value=$3 } END { print value + 0 }' "$RAW_OUTPUT")"

python3 - "$SUMMARY" "$HISTORY" "$started_at" "$commit" "$branch" "$duration" "$test_exit" "$build_exit" "$run_exit" "$passed" "$failed" <<'PY'
import json
import sys
from pathlib import Path

summary, history, ts, commit, branch, duration, test_exit, build_exit, run_exit, passed, failed = sys.argv[1:]
record = {
    "ts": ts,
    "commit": commit,
    "branch": branch or "detached",
    "project": "vpn-panel",
    "passed": int(passed),
    "failed": int(failed),
    "duration_s": int(duration),
    "npm_test_exit_code": int(test_exit),
    "npm_build_exit_code": int(build_exit),
    "exit_code": int(run_exit),
    "raw_output_file": "vpn-panel.txt",
}
Path(summary).write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
with Path(history).open("a", encoding="utf-8") as stream:
    stream.write(json.dumps(record, ensure_ascii=False) + "\n")
PY

printf '[test2git] %s: %s passed, %s failed, test=%s build=%s -> %s\n' \
  "$([ "$run_exit" -eq 0 ] && printf GREEN || printf RED)" "$passed" "$failed" "$test_exit" "$build_exit" "$SUMMARY"

if [[ "${TEST2GIT_BLOCK:-0}" == "1" ]]; then
  exit "$run_exit"
fi
