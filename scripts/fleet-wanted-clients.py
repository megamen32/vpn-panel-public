#!/usr/bin/env python3
"""
Print the Reality client list a fleet node must carry, as JSON on stdout.

Two sources, and losing the second one silently breaks a relay:
  * `vpn_clients` — the paying clients, the authoritative list
  * `serviceClients` in deploy/vpn-fleet.json — host-local service accounts

The second source exists because server-100's relay authenticates to the
Finland Reality with its own UUID, which is not a vpn_clients row. A sync
driven only by the table deletes it as "stale" and the Finnish exit dies with
no error anywhere: HAProxy still reports the backend UP and clients keep
opening sessions against a tunnel that cannot authenticate.

Uses psql rather than a python driver: the system python has no `pg` module,
and the panel already depends on psql for every other administrative query.
"""
import json
import os
import subprocess
import sys

FLEET = "deploy/vpn-fleet.json"


def db_uuids():
    url = os.environ.get("DATABASE_URL", "")
    if not url:
        raise SystemExit("DATABASE_URL is required")
    out = subprocess.run(
        ["psql", url, "-t", "-A", "-c",
         "select c.xray_uuid::text from vpn_clients c "
         "join accounts a on a.id = c.account_id "
         "where c.enabled and a.enabled order by a.login"],
        capture_output=True, text=True, timeout=60,
    )
    if out.returncode != 0:
        raise SystemExit(f"psql failed: {(out.stderr or '').strip()[:200]}")
    return {line.strip() for line in out.stdout.splitlines() if line.strip()}


def main():
    alias = sys.argv[1]
    fleet = json.load(open(FLEET))
    if alias not in fleet:
        raise SystemExit(f"unknown fleet alias: {alias}")

    clients = db_uuids()
    service = [u for u in (fleet[alias].get("serviceClients") or []) if u not in clients]
    wanted = sorted(clients | set(service))

    print(f"  {alias}: {len(clients)} clients from DB"
          + (f" + {len(service)} service account(s)" if service else "")
          + f" = {len(wanted)} total", file=sys.stderr)
    json.dump(wanted, sys.stdout)


if __name__ == "__main__":
    main()