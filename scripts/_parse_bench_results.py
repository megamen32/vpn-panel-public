#!/usr/bin/env python3
"""Parse benchmark JSON results, print status per endpoint to stderr,
write comma-separated working endpoint IDs to a temp file.

Usage: _parse_bench_results.py <result.json> <critical_sites.txt>

critical_sites.txt: one site label per line (e.g. "Telegram", "YouTube", "t.me")
Output file: same dir as result.json, named .working-<pid>.txt
"""
import json, os, sys

result_file = sys.argv[1]
critical_file = sys.argv[2]

with open(critical_file) as f:
    critical = set(line.strip() for line in f if line.strip())

with open(result_file) as f:
    data = json.load(f)

working = []
for r in data.get("results", []):
    ep = r.get("endpoint", "?")
    if "error" in r:
        print(f"  {ep}: SKIP ({r['error']})", file=sys.stderr)
        continue
    sites = r.get("sites", [])
    ep_critical = [s for s in sites if s.get("label") in critical]
    fails = [s for s in ep_critical if not s.get("ok")]
    if fails:
        fail_str = ", ".join(f'{s["label"]}={s["code"]}' for s in fails)
        print(f"  {ep}: FAIL ({fail_str})", file=sys.stderr)
    else:
        print(f"  {ep}: PASS", file=sys.stderr)
        working.append(ep)

# Write result to temp file
out_dir = os.path.dirname(result_file)
out_file = os.path.join(out_dir, f".working-{os.getpid()}.txt")
with open(out_file, "w") as f:
    f.write(",".join(working))
