#!/usr/bin/env python3
"""
Explore Fingerprints — test all known uTLS fingerprints against a stable endpoint
to discover which ones work reliably. Results are written to a JSON file only;
no production configs are modified.

Usage:
    # Auto-detect stable endpoint from subscription, test all fingerprints
    python3 explore-fingerprints.py

    # Target a specific endpoint by ID substring
    python3 explore-fingerprints.py --endpoint de-direct

    # Custom subscription URL
    python3 explore-fingerprints.py --subscription https://vpn.bezrabotnyi.com/sub/TOKEN/plain

    # Specify which fingerprints to test
    python3 explore-fingerprints.py --fingerprints firefox,chrome,safari,ios,randomized

    # Also vary fragment + noises per fingerprint
    python3 explore-fingerprints.py --vary-params

Results are saved to vpn-testing/results/explore-{timestamp}.json
"""
import argparse
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

# Reuse helpers from probe.py
sys.path.insert(0, str(Path(__file__).parent))
from probe import (
    log, ok, warn, fail, BOLD, NC, GREEN, YELLOW, RED, CYAN,
    fetch_subscription, parse_vless_link, gen_xray_config, gen_singbox_config,
    start_engine, stop_engine, socks_curl, run_cmd, node_reachable, get_node_ip,
    SOCKS_PORT, SITES, XRAY_IMAGE,
)

# All known uTLS fingerprints supported by Xray
ALL_FINGERPRINTS = [
    "firefox",
    "chrome",
    "safari",
    "ios",
    "android",
    "edge",
    "360",
    "qq",
    "randomized",
    "randomizednois",
]

# Fingerprints relevant for Reality (TCP-based)
REALITY_FINGERPRINTS = [
    "firefox",
    "chrome",
    "safari",
    "ios",
    "randomized",
]

# Fingerprints relevant for TLS transports (non-Reality)
TLS_FINGERPRINTS = [
    "firefox",
    "chrome",
    "safari",
    "ios",
    "edge",
    "randomized",
]


def test_fingerprint(
    ep: Dict[str, Any],
    fingerprint: str,
    engine: str,
    node: str,
    socks_port: int,
    timeout: int,
    *,
    fragment: bool = False,
    noises: bool = False,
) -> Dict[str, Any]:
    """Test a single fingerprint against an endpoint. Returns result dict."""
    id_ = ep["id"]
    tag = f"{id_}/fp={fingerprint}"
    if fragment:
        tag += "+frag"
    if noises:
        tag += "+noise"
    log(f"  Testing: {BOLD}{tag}{NC}")

    result: Dict[str, Any] = {
        "fingerprint": fingerprint,
        "fragment": fragment,
        "noises": noises,
    }

    # Generate config with the target fingerprint
    config_file = f"/tmp/explore-{engine}-{id_}-{fingerprint}.json"
    container_name = f"explore-{engine}-{id_}-{fingerprint}"

    with open(config_file, "w") as f:
        if engine == "xray":
            f.write(gen_xray_config(ep, socks_port, fingerprint=fingerprint, fragment=fragment, noises=noises))
        else:
            f.write(gen_singbox_config(ep, socks_port, fingerprint=fingerprint))

    start_engine(engine, config_file, container_name, node)
    time.sleep(3)

    # 1. Tunnel check (gstatic 204)
    probe_raw = socks_curl(
        ["--socks5-hostname", f"127.0.0.1:{socks_port}", "--max-time", "5",
         "-o", "/dev/null", "-w", "%{http_code}", "https://www.gstatic.com/generate_204"],
        node, timeout=10,
    )
    tunnel_up = probe_raw in ("204", "200")
    result["tunnel_up"] = tunnel_up

    if not tunnel_up:
        result.update({"exit_ip": "", "sites_ok": 0, "sites_total": len(SITES), "speed_mbps": 0.0, "stable": False})
        stop_engine(engine, container_name, node)
        return result

    # 2. Exit IP
    exit_ip = socks_curl(
        ["--socks5-hostname", f"127.0.0.1:{socks_port}", "-s", "--max-time", "10", "https://ifconfig.me"],
        node, timeout=15,
    )
    result["exit_ip"] = exit_ip

    # 3. Site accessibility
    sites_ok = 0
    for site in SITES:
        raw = socks_curl(
            ["--socks5-hostname", f"127.0.0.1:{socks_port}", "-s", "--max-time", str(timeout),
             "-w", "%{http_code}", "-o", "/dev/null", f"https://{site}"],
            node, timeout=timeout + 5,
        )
        http_code = raw.split()[0] if raw else "000"
        if http_code == "200":
            sites_ok += 1

    result["sites_ok"] = sites_ok
    result["sites_total"] = len(SITES)

    # 4. Speed check (2MB download)
    speed_bytes = socks_curl(
        ["--socks5-hostname", f"127.0.0.1:{socks_port}", "-s", "--max-time", "30",
         "-o", "/dev/null", "-w", "%{speed_download}",
         "https://speed.cloudflare.com/__down?bytes=2000000"],
        node, timeout=35,
    )
    try:
        speed_mbps = round(float(speed_bytes or "0") * 8 / 1_000_000, 2)
    except ValueError:
        speed_mbps = 0.0
    result["speed_mbps"] = speed_mbps

    # 5. Stability verdict: tunnel up + at least 4/6 sites + speed > 1 Mbps
    result["stable"] = tunnel_up and sites_ok >= 4 and speed_mbps > 1.0

    stop_engine(engine, container_name, node)
    return result


def pick_stable_endpoint(parsed_endpoints: List[Dict[str, Any]], endpoint_filter: str) -> Optional[Dict[str, Any]]:
    """Pick the best endpoint to use as the stable baseline for fingerprint exploration."""
    candidates = parsed_endpoints
    if endpoint_filter:
        candidates = [ep for ep in candidates if endpoint_filter in ep["id"]]

    if not candidates:
        return None

    # Prefer Reality endpoints (most fingerprint-sensitive), then high-port direct
    reality = [ep for ep in candidates if ep.get("security") == "reality"]
    if reality:
        return reality[0]

    # Fall back to first candidate
    return candidates[0]


def print_explore_report(results_file: Path) -> None:
    """Print a summary table of fingerprint exploration results."""
    with open(results_file) as f:
        data = json.load(f)

    print(f"\n{BOLD}=== Fingerprint Exploration: {data['node']} ({data['engine']}) ==={NC}", file=sys.stderr)
    print(f"  Endpoint: {data['endpoint_id']} ({data['endpoint_address']}:{data['endpoint_port']})", file=sys.stderr)
    print(f"  Security: {data['endpoint_security']}", file=sys.stderr)
    print(file=sys.stderr)

    header = f"  {'Fingerprint':<14} {'Frag':<5} {'Noise':<6} {'Tunnel':<7} {'Sites':<8} {'Speed':<10} {'Stable':<7}"
    print(header, file=sys.stderr)
    print("  " + "-" * 60, file=sys.stderr)

    stable_count = 0
    for r in data["results"]:
        fp = r["fingerprint"]
        frag = f"{GREEN}on{NC}" if r.get("fragment") else "off"
        noise = f"{GREEN}on{NC}" if r.get("noises") else "off"
        tunnel = f"{GREEN}UP{NC}" if r.get("tunnel_up") else f"{RED}DOWN{NC}"
        sites = f"{r.get('sites_ok', 0)}/{r.get('sites_total', 0)}"
        speed = r.get("speed_mbps", 0)
        speed_s = f"{GREEN}{speed:.1f}{NC}" if speed > 5 else (f"{YELLOW}{speed:.1f}{NC}" if speed > 0 else f"{RED}0.0{NC}")
        stable = r.get("stable", False)
        stable_s = f"{GREEN}YES{NC}" if stable else f"{RED}no{NC}"
        if stable:
            stable_count += 1

        print(f"  {fp:<14} {frag:<12} {noise:<13} {tunnel:<14} {sites:<15} {speed_s} Mbps   {stable_s}", file=sys.stderr)

    print(file=sys.stderr)
    print(f"  {BOLD}Stable fingerprints found: {stable_count}{NC}", file=sys.stderr)

    stable_fps = [r["fingerprint"] for r in data["results"] if r.get("stable")]
    if stable_fps:
        print(f"  {GREEN}Recommend: {', '.join(sorted(set(stable_fps)))}{NC}", file=sys.stderr)
    else:
        print(f"  {RED}No stable fingerprints found — endpoint may be down or blocked{NC}", file=sys.stderr)
    print(file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(
        description="Explore uTLS fingerprints against a stable VPN endpoint",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--node", default="server-100", help="Node to run probe from: server-100, mac, server-44, server-88")
    parser.add_argument("--engine", default="xray", choices=["xray", "singbox"], help="Proxy engine (default: xray)")
    parser.add_argument("--subscription", default="", help="Subscription URL (auto-fetch from local panel if omitted)")
    parser.add_argument("--endpoint", default="", help="Endpoint ID substring to target (auto-picks stable if omitted)")
    parser.add_argument("--fingerprints", default="", help="Comma-separated fingerprints (default: auto based on security type)")
    parser.add_argument("--timeout", type=int, default=15, help="Timeout per site in seconds")
    parser.add_argument("--vary-params", action="store_true", help="Also test fragment on/off x noises on/off per fingerprint")
    parser.add_argument("--dry-run", action="store_true", help="Only list what would be tested, don't actually probe")
    args = parser.parse_args()

    script_dir = Path(__file__).parent.resolve()
    results_dir = script_dir / "results"
    results_dir.mkdir(parents=True, exist_ok=True)

    # 1. Fetch subscription
    log("Fetching subscription...")
    sub_text = fetch_subscription(args.subscription)
    if not sub_text:
        fail("Empty subscription — pass --subscription URL or check panel")
        sys.exit(1)

    # 2. Parse endpoints
    log("Parsing VLESS links...")
    parsed = [ep for line in sub_text.splitlines() if (ep := parse_vless_link(line.strip()))]
    log(f"Parsed {len(parsed)} endpoints")
    if not parsed:
        fail("No endpoints found in subscription")
        sys.exit(1)

    # 3. Pick target endpoint
    target = pick_stable_endpoint(parsed, args.endpoint)
    if not target:
        fail(f"No endpoint matching '{args.endpoint}'")
        sys.exit(1)

    log(f"Target endpoint: {BOLD}{target['id']}{NC} ({target['address']}:{target['port']}, {target['security']})")

    # 4. Determine fingerprints to test
    if args.fingerprints:
        fp_list = [f.strip() for f in args.fingerprints.split(",") if f.strip()]
    elif target.get("security") == "reality":
        fp_list = REALITY_FINGERPRINTS
    else:
        fp_list = TLS_FINGERPRINTS

    # 5. Build test matrix
    frag_list = ["on", "off"] if args.vary_params else ["off"]
    noise_list = ["on", "off"] if args.vary_params else ["off"]

    test_matrix: List[Dict[str, Any]] = []
    for fp in fp_list:
        for frag in frag_list:
            for noise in noise_list:
                test_matrix.append({"fingerprint": fp, "fragment": frag == "on", "noises": noise == "on"})

    log(f"Test matrix: {len(fp_list)} fingerprints x {len(frag_list)} fragment x {len(noise_list)} noises = {BOLD}{len(test_matrix)} combos{NC}")

    if args.dry_run:
        print(f"\n{BOLD}Dry run — would test:{NC}")
        for i, t in enumerate(test_matrix, 1):
            label = f"fp={t['fingerprint']}"
            if t["fragment"]:
                label += " +fragment"
            if t["noises"]:
                label += " +noises"
            print(f"  {i:3d}. {label}")
        print(f"\n  Endpoint: {target['id']} ({target['address']}:{target['port']})")
        print(f"  Engine: {args.engine}, Node: {args.node}")
        return

    # 6. Check node reachability
    node = args.node
    if not node_reachable(node):
        fail(f"Node {node} unreachable")
        sys.exit(1)
    node_ip = get_node_ip(node)
    log(f"Node: {BOLD}{node}{NC} (IP: {node_ip})")

    # 7. Run tests
    all_results: List[Dict[str, Any]] = []
    for i, test in enumerate(test_matrix, 1):
        log(f"[{i}/{len(test_matrix)}] fingerprint={test['fingerprint']} fragment={test['fragment']} noises={test['noises']}")
        result = test_fingerprint(
            target, test["fingerprint"], args.engine, node, SOCKS_PORT, args.timeout,
            fragment=test["fragment"], noises=test["noises"],
        )
        all_results.append(result)

        # Brief inline feedback
        status = f"{GREEN}STABLE{NC}" if result["stable"] else f"{RED}unstable{NC}"
        log(f"  -> tunnel={'UP' if result['tunnel_up'] else 'DOWN'}, "
            f"sites={result.get('sites_ok', 0)}/{result.get('sites_total', 0)}, "
            f"speed={result.get('speed_mbps', 0):.1f} Mbps, {status}")

    # 8. Write results
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    result_file = results_dir / f"explore-{node}-{args.engine}-{ts}.json"
    output = {
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "node": node,
        "network_ip": node_ip,
        "engine": args.engine,
        "endpoint_id": target["id"],
        "endpoint_address": target["address"],
        "endpoint_port": target["port"],
        "endpoint_security": target.get("security", "unknown"),
        "fingerprints_tested": fp_list,
        "results": all_results,
        "stable_fingerprints": sorted(set(r["fingerprint"] for r in all_results if r.get("stable"))),
    }
    with open(result_file, "w") as f:
        json.dump(output, f, indent=2)

    log(f"Results written to: {BOLD}{result_file}{NC}")

    # 9. Print summary
    print_explore_report(result_file)

    # 10. Also write a concise summary to a fixed "latest" file for easy reference
    latest_file = results_dir / "explore-latest.json"
    with open(latest_file, "w") as f:
        json.dump(output, f, indent=2)
    log(f"Latest results: {BOLD}{latest_file}{NC}")

    log("Exploration complete.")


if __name__ == "__main__":
    main()
