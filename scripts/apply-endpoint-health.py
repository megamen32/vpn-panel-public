#!/usr/bin/env python3
"""Apply a unified health run to panel health/profile state."""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Mapping


ENDPOINT_ID = re.compile(r"^[A-Za-z0-9._-]+$")
CANONICAL_RELAYS = ["smart-de-relay", "full-de-relay", "smart-us-relay", "full-us-relay"]
REQUIRED_SUBSCRIPTION_ENDPOINTS = ["ru-full-relay", "fi-helsinki-relay"]
LEGACY_FALLBACK_ENDPOINTS = [
    "smart-de-relay-mobile", "full-de-relay-mobile", "smart-us-relay-mobile", "full-us-relay-mobile",
    "de-httpupgrade", "de-direct-ws", "de-xhttp", "de-grpc", "de-cdn", "de-cdn2",
    "de-xhttp-h2", "us-reality", "us-xhttp", "us-httpupgrade", "us-direct-ws",
    "us-grpc", "us-cdn", "us-cdn2", "us-xhttp-h2-443", "us-xhttp-h2", "de-direct",
]

# A verdict is a bounded window of tunnel observations, not one sample. One
# transient failure must not condemn an endpoint for the life of the row, and
# one success must not bless it: both are decided by this many hours of history.
DEFAULT_WINDOW_HOURS = 6

# Every verdict below is produced by driving real traffic through the endpoint
# and observing the exit IP. A TCP or TLS handshake that never carries traffic
# is not evidence of a working tunnel and must never be published as one.
VERDICT_METHOD = "tunnel"


def health_window_hours() -> int:
    """Return the observation window used to decide a verdict."""
    raw = os.environ.get("HEALTH_WINDOW_HOURS", "").strip()
    if not raw:
        return DEFAULT_WINDOW_HOURS
    try:
        hours = int(raw)
    except ValueError:
        return DEFAULT_WINDOW_HOURS
    return hours if hours > 0 else DEFAULT_WINDOW_HOURS


def always_include_endpoints() -> List[str]:
    """Keep contractual products in every automatic subscription update."""
    configured = [value for value in os.environ.get("ALWAYS_INCLUDE_ENDPOINTS", "").split(",") if value]
    return list(dict.fromkeys([*REQUIRED_SUBSCRIPTION_ENDPOINTS, *configured]))


def public_catalog_endpoints(database_url: str) -> List[str]:
    """Return every enabled endpoint the panel itself declares a public product.

    The subscription builder treats `public_catalog` as the declaration that an
    endpoint is sold to clients, so a health run has no authority to withdraw
    one. Reading the flag from the endpoint instead of repeating it here means
    the next product added to the catalog is protected the day it ships, rather
    than the day somebody notices its links vanished.
    """
    if not database_url:
        return []
    sql = """
select id from endpoints
 where enabled = true
   and coalesce((config->>'public_catalog')::boolean, false)
 order by id
"""
    completed = subprocess.run(
        ["psql", database_url, "-At", "-v", "ON_ERROR_STOP=1"], input=sql, text=True, capture_output=True, check=False,
    )
    if completed.returncode != 0:
        print(f"public catalog unavailable: {completed.stderr.strip()}", file=sys.stderr)
        return []
    return [line.strip() for line in completed.stdout.splitlines() if ENDPOINT_ID.fullmatch(line.strip())]


def proven_eligible_relays(run: Dict[str, Any]) -> List[str]:
    """Return canonical products that the current run proved eligible."""
    return [endpoint["endpoint"] for endpoint in run["endpoints"] if endpoint.get("eligible") and endpoint["endpoint"] in CANONICAL_RELAYS]


def eligible_relays(run: Dict[str, Any]) -> List[str]:
    """Return proven products, or the public catalog when every probe failed."""
    proven = proven_eligible_relays(run)
    return proven or list(CANONICAL_RELAYS)


def expected_endpoint_ids(run: Mapping[str, Any]) -> List[str]:
    """Return every enabled endpoint this collector is meant to cover.

    Coverage is defined by the enabled catalog, not by the probe document. An
    endpoint that the probe subscription cannot express must still appear in
    the payload, otherwise its previous verdict silently outlives the run that
    failed to measure it.
    """
    catalog = [str(item) for item in (run.get("endpointSelection") or {}).get("catalog") or []]
    if catalog:
        return list(dict.fromkeys(catalog))
    return [str(endpoint["endpoint"]) for endpoint in run.get("endpoints", [])]


def observation_window(database_url: str, endpoint_ids: List[str], hours: int) -> Dict[str, Dict[str, Any]]:
    """Count recent tunnel verdicts per endpoint from the telemetry history.

    Runner errors are not endpoint failures and are excluded from the window,
    matching how the subscription score treats them.
    """
    if not endpoint_ids or not database_url:
        return {}
    sql = """
select endpoint_id,
       count(*)::int as observations,
       count(*) filter (where coalesce((payload->>'eligible')::boolean, false))::int as passed,
       max(event_timestamp) as last_at
  from vpn_test_events
 where event_type = 'endpoint_finished'
   and endpoint_id = any(string_to_array(:'ids', ','))
   and nullif(payload->>'error', '') is null
   and event_timestamp >= now() - (:'hours'::int * interval '1 hour')
 group by endpoint_id
"""
    completed = subprocess.run(
        ["psql", database_url, "-At", "-F", "|",
         "-v", f"ids={','.join(endpoint_ids)}", "-v", f"hours={hours}"],
        input=sql, text=True, capture_output=True, check=False,
    )
    if completed.returncode != 0:
        print(f"observation window unavailable: {completed.stderr.strip()}", file=sys.stderr)
        return {}
    window: Dict[str, Dict[str, Any]] = {}
    for line in completed.stdout.splitlines():
        parts = line.split("|")
        if len(parts) != 4 or not parts[0]:
            continue
        endpoint, observations, passed, last_at = parts
        if not observations or not last_at:
            continue
        window[endpoint] = {
            "passed": int(passed),
            "observations": int(observations),
            "last_at": last_at,
        }
    return window


def _measured_result(endpoint: Mapping[str, Any], window: Mapping[str, Dict[str, Any]]) -> Dict[str, Any]:
    """Convert one measured endpoint into a windowed health payload entry."""
    checks = endpoint.get("checks", [])
    reachable = [check for check in checks if check.get("reachable")]
    observation = window.get(str(endpoint["endpoint"]))
    if observation:
        observations = observation["observations"]
        passed = observation["passed"]
        return {
            "endpoint": endpoint["endpoint"],
            "pass": passed,
            "fail": max(0, observations - passed),
            "observations": observations,
            "latency_ms": reachable[0].get("latencyMs") if reachable else None,
            "speed_mbps": endpoint.get("throughput", {}).get("mbps"),
            "exit_ip": endpoint.get("exitIp"),
            "method": VERDICT_METHOD,
            "stale": False,
            "observed_at": observation["last_at"],
            "sites": [{
                "label": check["label"],
                "code": str(check.get("code", 0)),
                "ms": int(check.get("latencyMs", 0)),
                "ok": bool(check.get("reachable")),
            } for check in checks],
        }
    # Measured in this run but with no retained history: report the single
    # tunnel observation rather than inventing a window.
    return {
        "endpoint": endpoint["endpoint"],
        "pass": 1 if endpoint.get("eligible") else 0,
        "fail": 0 if endpoint.get("eligible") else 1,
        "observations": 1,
        "latency_ms": reachable[0].get("latencyMs") if reachable else None,
        "speed_mbps": endpoint.get("throughput", {}).get("mbps"),
        "exit_ip": endpoint.get("exitIp"),
        "method": VERDICT_METHOD,
        "stale": False,
        "observed_at": None,
        "sites": [{
            "label": check["label"],
            "code": str(check.get("code", 0)),
            "ms": int(check.get("latencyMs", 0)),
            "ok": bool(check.get("reachable")),
        } for check in checks],
    }


def _unmeasured_result(endpoint_id: str, window: Mapping[str, Dict[str, Any]]) -> Dict[str, Any]:
    """Describe an enabled endpoint this run could not measure.

    These are reported separately from measured verdicts and are deliberately
    never written as one. Publishing a zeroed counter would still refresh
    ``checked_at``, which would make an endpoint with no evidence at all look
    freshly measured. Leaving the row untouched keeps its real age visible,
    while the coverage report names the gap instead of hiding it.
    """
    observation = window.get(endpoint_id)
    return {
        "endpoint": endpoint_id,
        "reason": "not-probed",
        "last_observed_at": observation["last_at"] if observation else None,
        "stale": observation is None,
    }


def health_payload(run: Dict[str, Any], window: Mapping[str, Dict[str, Any]] | None = None) -> Dict[str, Any]:
    """Convert the unified result into the existing endpoint-health API shape."""
    window = window or {}
    measured = {str(endpoint["endpoint"]): endpoint for endpoint in run.get("endpoints", [])}
    expected = expected_endpoint_ids(run)
    results: List[Dict[str, Any]] = [_measured_result(endpoint, window) for endpoint in measured.values()]
    covered = set(measured)
    unmeasured: List[Dict[str, Any]] = []
    for endpoint_id in expected:
        if endpoint_id in covered:
            continue
        reason = "not-selected-for-this-run"
        selection = run.get("endpointSelection") or {}
        if endpoint_id not in set(selection.get("subscriptionAvailable") or []):
            reason = "absent-from-probe-subscription"
        entry = _unmeasured_result(endpoint_id, window)
        entry["reason"] = reason
        unmeasured.append(entry)
    return {"results": results, "unmeasured": unmeasured}


def apply_profiles(database_url: str, working: List[str], always_include: List[str]) -> None:
    """Replace endpoint assignments while retaining contractual owner relays."""
    for endpoint in [*working, *always_include]:
        if not ENDPOINT_ID.fullmatch(endpoint):
            raise ValueError(f"invalid endpoint id: {endpoint}")
    working_csv = ",".join(working)
    always_csv = ",".join(always_include)
    owner_profiles_csv = ",".join(dict.fromkeys([*working, *always_include]))
    # This run is authoritative about the endpoints it manages and about nothing
    # else. An endpoint the probe document could not express was never measured,
    # and treating "not measured" as "must not be served" is what silently
    # deletes a shipped product from every subscription: the Hysteria2 endpoints
    # vanished from all eleven clients within minutes of shipping, because they
    # are absent from the probe surface and so never appear in `working`.
    managed_csv = ",".join(dict.fromkeys([*working, *always_include, *LEGACY_FALLBACK_ENDPOINTS]))
    sql = """
begin;
-- A stale score must not silently remove a contractual relay from subscriptions.
update endpoints set enabled = true, updated_at = now()
where id = any(string_to_array(:'always_include', ','));
delete from client_profiles
 where endpoint_id = any(string_to_array(:'managed', ','));
insert into client_profiles (client_id, endpoint_id)
select vc.id, e.id from vpn_clients vc join accounts a on a.id=vc.account_id cross join endpoints e
where a.role='user' and a.login in ('geier25','Nikita')
  and e.id = any(string_to_array(:'owner_profiles', ','))
on conflict do nothing;
insert into client_profiles (client_id, endpoint_id)
select vc.id, e.id from vpn_clients vc join accounts a on a.id=vc.account_id cross join endpoints e
where a.role='user' and a.enabled=true and vc.enabled=true
  and e.id = any(string_to_array(:'legacy_fallbacks', ','))
on conflict do nothing;
insert into client_profiles (client_id, endpoint_id)
select vc.id, e.id from vpn_clients vc join accounts a on a.id=vc.account_id cross join endpoints e
where a.role='user' and a.login not in ('geier25','Nikita')
  and e.id = any(string_to_array(:'always_include', ','))
on conflict do nothing;
insert into client_profiles (client_id, endpoint_id)
select vc.id, e.id from vpn_clients vc join accounts a on a.id=vc.account_id cross join endpoints e
where a.role='user' and a.login not in ('geier25','Nikita')
  and e.id = any(string_to_array(:'working', ','))
on conflict do nothing;
commit;
"""
    legacy_fallbacks_csv = ",".join(LEGACY_FALLBACK_ENDPOINTS)
    subprocess.run(["psql", database_url, "-v", f"working={working_csv}", "-v", f"always_include={always_csv}", "-v", f"owner_profiles={owner_profiles_csv}", "-v", f"legacy_fallbacks={legacy_fallbacks_csv}", "-v", f"managed={managed_csv}",
        "-v", "ON_ERROR_STOP=1"], input=sql, text=True, check=True)


def main() -> int:
    """CLI entrypoint."""
    parser = argparse.ArgumentParser()
    parser.add_argument("result", type=Path)
    parser.add_argument("--health-output", type=Path)
    parser.add_argument("--apply-profiles", action="store_true")
    parser.add_argument("--require-canonical-relays", action="store_true")
    args = parser.parse_args()
    run = json.loads(args.result.read_text(encoding="utf-8"))
    proven_working = proven_eligible_relays(run)
    working = eligible_relays(run)
    # Fail closed before touching the database. Reading the observation window
    # is still work on a run that must not apply anything, and the canonical
    # relay assertion must hold before any process is spawned.
    if not proven_working and (args.apply_profiles or args.require_canonical_relays):
        print("health assertion failed: 0/4 canonical relays are eligible", file=sys.stderr)
        return 3

    window = observation_window(os.environ.get("DATABASE_URL", ""), expected_endpoint_ids(run), health_window_hours())
    payload = health_payload(run, window)
    if args.health_output:
        args.health_output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    else:
        print(json.dumps(payload, ensure_ascii=False))

    if args.apply_profiles:
        database_url = os.environ.get("DATABASE_URL")
        if not database_url:
            raise RuntimeError("DATABASE_URL is required for --apply-profiles")
        always_include = always_include_endpoints()
        # A catalog fallback is display-only; profile updates require a
        # currently proven canonical relay and must never expand an outage.
        working = proven_working
        # An endpoint the panel declares public is a sold product, so a health
        # run keeps it assigned no matter whether this run could probe it.
        always_include = list(dict.fromkeys([*always_include, *public_catalog_endpoints(database_url)]))
        apply_profiles(database_url, working, always_include)
        state_path = Path(os.environ.get("WORKING_STATE_FILE", "/home/roomhacker/apps/vpn-panel/logs/last-working-hash"))
        state_path.parent.mkdir(parents=True, exist_ok=True)
        new_hash = hashlib.sha256("\n".join(working).encode()).hexdigest()
        old_hash = state_path.read_text().strip() if state_path.exists() else ""
        if new_hash != old_hash:
            subprocess.run(["sudo", "systemctl", "restart", "autovpnallowip.service"], check=False)
            state_path.write_text(new_hash + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
