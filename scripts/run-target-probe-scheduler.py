#!/usr/bin/env python3
"""Dispatch per-target VPN measurements without changing manual-run cadence."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import time

REPO = Path(__file__).resolve().parent.parent
PLAN = Path(os.environ.get("TARGET_PROBE_PLAN", REPO / "vpn-testing/test-plan.json"))
STATE = Path(os.environ.get(
    "TARGET_PROBE_STATE",
    REPO / "vpn-testing/results/target-probe-scheduler/state.json",
))
RUNNER = os.environ.get("TARGET_PROBE_RUNNER", str(REPO / "scripts/auto-endpoint-check.sh"))
DEFAULT_CONCURRENCY = 5


def load_json(path: Path, default: dict) -> dict:
    try:
        with path.open(encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return default


def configured_targets(plan: dict) -> list[dict]:
    targets = []
    for target in plan.get("testTargets", []):
        schedule = target.get("probeSchedule")
        if not isinstance(schedule, dict):
            continue
        interval = schedule.get("everyMinutes")
        if not isinstance(interval, int) or isinstance(interval, bool) or interval < 1:
            raise ValueError(f'{target.get("id", "<unknown>")}: probeSchedule.everyMinutes must be a positive integer')
        profile = schedule.get("profile", "health")
        if not isinstance(profile, str) or not profile:
            raise ValueError(f'{target.get("id", "<unknown>")}: probeSchedule.profile must be a non-empty string')
        targets.append({
            "id": target["id"],
            "enabled": schedule.get("enabled", False) is True,
            "everyMinutes": interval,
            "profile": profile,
        })
    return targets


def atomic_write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def run_target(target: dict) -> tuple[str, int]:
    env = os.environ.copy()
    env["TARGETS"] = target["id"]
    env["PROFILE"] = target["profile"]
    # The shared plan is already current. Concurrent workers must not rewrite it.
    env["RENDER_TEST_PLAN"] = "0"
    result = subprocess.run([RUNNER], cwd=REPO, env=env, check=False)
    return target["id"], result.returncode


def main() -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--due", action="store_true", help="run enabled targets whose interval elapsed")
    mode.add_argument("--target", action="append", help="run this target now without changing its due time")
    mode.add_argument("--list", action="store_true", help="print configured target schedules")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--now", type=int, default=None, help=argparse.SUPPRESS)
    args = parser.parse_args()

    targets = configured_targets(load_json(PLAN, {}))
    by_id = {target["id"]: target for target in targets}
    if args.list:
        print(json.dumps(targets, indent=2, ensure_ascii=False))
        return 0

    now = args.now if args.now is not None else int(time.time())
    STATE.parent.mkdir(parents=True, exist_ok=True)
    lock_path = STATE.with_suffix(".lock")
    with lock_path.open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("Another target probe scheduler is already running", file=sys.stderr)
            return 75

        state = load_json(STATE, {"schemaVersion": 1, "targets": {}})
        scheduled = args.due
        if args.target:
            unknown = sorted(set(args.target) - set(by_id))
            if unknown:
                print(f'Unknown scheduled target(s): {", ".join(unknown)}', file=sys.stderr)
                return 2
            selected = [by_id[target_id] for target_id in args.target]
        else:
            selected = []
            for target in targets:
                target_state = state.get("targets", {}).get(target["id"], {})
                previous = target_state.get(
                    "lastScheduledAttemptEpoch",
                    target_state.get("lastScheduledSuccessEpoch", 0),
                )
                if target["enabled"] and now - previous >= target["everyMinutes"] * 60:
                    selected.append(target)

        if not selected:
            print("No target measurements are due")
            return 0

        for target in selected:
            print(f'Running {target["id"]} profile={target["profile"]} interval={target["everyMinutes"]}m')
        if args.dry_run:
            return 0

        if scheduled:
            for target in selected:
                target_state = state.setdefault("targets", {}).setdefault(target["id"], {})
                target_state.update({
                    "lastScheduledAttemptEpoch": now,
                    "profile": target["profile"],
                })
            atomic_write(STATE, state)

        try:
            concurrency = int(os.environ.get("TARGET_PROBE_CONCURRENCY", DEFAULT_CONCURRENCY))
        except ValueError:
            print("TARGET_PROBE_CONCURRENCY must be an integer", file=sys.stderr)
            return 2
        if concurrency < 1 or concurrency > 16:
            print("TARGET_PROBE_CONCURRENCY must be between 1 and 16", file=sys.stderr)
            return 2

        failed = False
        workers = min(concurrency, len(selected))
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {executor.submit(run_target, target): target for target in selected}
            for future in as_completed(futures):
                target = futures[future]
                try:
                    target_id, returncode = future.result()
                except Exception as error:
                    failed = True
                    print(f'{target["id"]}: measurement crashed: {error}', file=sys.stderr)
                    continue
                if returncode:
                    failed = True
                    print(f'{target_id}: measurement failed with status {returncode}', file=sys.stderr)
                    continue
                print(f'{target_id}: measurement completed')
                if scheduled:
                    state.setdefault("targets", {}).setdefault(target_id, {}).update({
                        "lastScheduledSuccessEpoch": now,
                        "profile": target["profile"],
                    })
                    atomic_write(STATE, state)
        return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
