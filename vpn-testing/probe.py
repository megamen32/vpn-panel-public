#!/usr/bin/env python3
import argparse
import json
import re
import socket
import subprocess
import sys
import time
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

# ─── Constants & Colors ──────────────────────────────────────────────────────
RED = '\033[0;31m'
GREEN = '\033[0;32m'
YELLOW = '\033[1;33m'
CYAN = '\033[0;36m'
BOLD = '\033[1m'
NC = '\033[0m'

SITES = ["chatgpt.com", "youtube.com", "telegram.org", "instagram.com", "discord.com", "whatsapp.com"]
SSH_HOSTS = {
    "mac": "user@localhost -p 2222",
    "server-44": "192.168.2.5",
    "server-88": "192.168.2.75"
}
SOCKS_PORT = 11080
XRAY_IMAGE = "teddysun/xray:26.6.1"
SINGBOX_IMAGE = "ghcr.io/sagernet/sing-box:v1.13.14"

# ─── Logging Helpers ─────────────────────────────────────────────────────────
def log(msg: str) -> None: print(f"{CYAN}[{datetime.now().strftime('%H:%M:%S')}]{NC} {msg}", file=sys.stderr)
def ok(msg: str) -> None: print(f"{GREEN}[OK]{NC} {msg}", file=sys.stderr)
def warn(msg: str) -> None: print(f"{YELLOW}[WARN]{NC} {msg}", file=sys.stderr)
def fail(msg: str) -> None: print(f"{RED}[FAIL]{NC} {msg}", file=sys.stderr)

# ─── Network & Subprocess Helpers ────────────────────────────────────────────
def run_cmd(args: List[str], timeout: int = 15, capture: bool = True) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            args,
            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
            stderr=subprocess.PIPE if capture else subprocess.DEVNULL,
            text=True,
            timeout=timeout
        )
    except Exception:
        return subprocess.CompletedProcess(args, returncode=1, stdout="", stderr="")

def socks_curl(args: List[str], node: str, timeout: int = 15) -> str:
    cmd = ["curl"] + args
    if node == "mac":
        # Passing the curl array directly to ssh is safe and avoids shell quoting issues
        cmd = ["ssh", "-n", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no"] + SSH_HOSTS["mac"].split() + cmd
    res = run_cmd(cmd, timeout=timeout)
    return res.stdout.strip()

# ─── VLESS Parsing ───────────────────────────────────────────────────────────
def parse_vless_link(link: str) -> Optional[Dict[str, Any]]:
    if not link.startswith("vless://"): return None
    proto_rest = link[len("vless://"):]
    uuid, rest = proto_rest.split("@", 1)
    
    fragment = ""
    if "#" in rest:
        rest, fragment = rest.split("#", 1)
        fragment = urllib.parse.unquote(fragment)
        
    hostport, query = rest, ""
    if "?" in rest:
        hostport, query = rest.split("?", 1)
        
    address, port = hostport, 443
    if ":" in hostport:
        parts = hostport.rsplit(":", 1)
        address = parts[0]
        try: port = int(parts[1])
        except ValueError: port = 443
            
    params = urllib.parse.parse_qs(query)
    def get_param(key: str, default: str = "") -> str:
        return urllib.parse.unquote(params.get(key, [default])[0])
        
    type_ = get_param("type", "tcp")
    security = get_param("security", "tls")
    
    id_str = re.sub(r'[^a-zA-Z0-9_-]', '-', fragment)
    id_str = re.sub(r'-+', '-', id_str).strip('-').lower()
    if not id_str: id_str = f"{address}-{port}-{type_}"
        
    return {
        "id": id_str, "name": fragment, "uuid": uuid, "address": address, "port": port,
        "type": type_, "security": security, "sni": get_param("sni"), "path": get_param("path"),
        "host": get_param("host"), "fp": get_param("fp"), "pbk": get_param("pbk"),
        "sid": get_param("sid"), "alpn": get_param("alpn"), "flow": get_param("flow")
    }

# ─── Config Generators ───────────────────────────────────────────────────────
def gen_xray_config(ep: Dict[str, Any], socks_port: int, *, fingerprint: str = "", fragment: bool = False, noises: bool = False) -> str:
    user_obj = {"id": ep["uuid"], "encryption": "none"}
    if ep.get("flow") and ep["flow"] != "null": user_obj["flow"] = ep["flow"]
        
    network = ep["type"] or "tcp"
    fp = fingerprint or ep.get("fp") or "firefox"
    fragment_obj = {"packets": "tlshello", "length": "1-10", "interval": "5-20"} if fragment else None
    noises_arr = [{"type": "rand", "packet": "50-150", "delay": "10-50"}] if noises else None
    stream_settings: Dict[str, Any] = {}
    
    if ep["security"] == "reality":
        rs: Dict[str, Any] = {"serverName": ep["sni"], "fingerprint": fp, "publicKey": ep["pbk"], "shortId": ep["sid"]}
        if fragment_obj: rs["fragment"] = fragment_obj
        if noises_arr: rs["noises"] = noises_arr
        stream_settings = {"network": network, "security": "reality", "realitySettings": rs}
    else:
        tls_settings: Dict[str, Any] = {"serverName": ep["sni"], "fingerprint": fp}
        if fragment_obj: tls_settings["fragment"] = fragment_obj
        if network == "ws": tls_settings["alpn"] = ["http/1.1"]
        elif ep.get("alpn") and ep["alpn"] != "null": tls_settings["alpn"] = ep["alpn"].split(",")
            
        stream_settings = {"network": network, "security": "tls", "tlsSettings": tls_settings}
        
        if network in ("ws", "httpupgrade", "xhttp"):
            settings_key = f"{network}Settings"
            s = {"path": ep["path"]}
            if network == "xhttp": s.update({"mode": "auto", "h2": False})
            if ep.get("host") and ep["host"] != "null": s["host"] = ep["host"]
            stream_settings[settings_key] = s
        elif network == "grpc":
            stream_settings["grpcSettings"] = {"serviceName": ep["path"], "multiMode": True}

    return json.dumps({
        "log": {"loglevel": "error"},
        "inbounds": [{"tag": "socks-in", "port": socks_port, "listen": "127.0.0.1", "protocol": "socks", "settings": {"auth": "noauth", "udp": True}}],
        "outbounds": [
            {"tag": "proxy", "protocol": "vless", "settings": {"vnext": [{"address": ep["address"], "port": ep["port"], "users": [user_obj]}]}, "streamSettings": stream_settings},
            {"tag": "direct", "protocol": "freedom"}
        ],
        "routing": {"rules": [{"type": "field", "network": "tcp,udp", "outboundTag": "proxy"}]}
    }, indent=2)

def gen_singbox_config(ep: Dict[str, Any], socks_port: int, *, fingerprint: str = "") -> str:
    fp = fingerprint or ep.get("fp") or "firefox"
    tls_obj = {"enabled": True, "server_name": ep["sni"], "utls": {"enabled": True, "fingerprint": fp}}
    if ep["security"] == "reality":
        tls_obj["reality"] = {"enabled": True, "public_key": ep["pbk"], "short_id": ep["sid"]}
        
    outbound = {"type": "vless", "tag": "proxy", "server": ep["address"], "server_port": ep["port"], "uuid": ep["uuid"], "tls": tls_obj}
    if ep.get("flow") and ep["flow"] != "null": outbound["flow"] = ep["flow"]
        
    if ep["security"] != "reality" and ep["type"] not in ("tcp", "null", ""):
        if ep["type"] == "ws":
            t = {"type": "ws", "path": ep["path"]}
            if ep.get("host") and ep["host"] != "null": t["headers"] = {"Host": ep["host"]}
            outbound["transport"] = t
        elif ep["type"] == "httpupgrade":
            t = {"type": "httpupgrade", "path": ep["path"]}
            if ep.get("host") and ep["host"] != "null": t["host"] = ep["host"]
            outbound["transport"] = t
        elif ep["type"] == "grpc":
            outbound["transport"] = {"type": "grpc", "service_name": ep["path"]}

    return json.dumps({
        "log": {"level": "error"},
        "inbounds": [{"type": "socks", "tag": "socks-in", "listen": "127.0.0.1", "listen_port": socks_port}],
        "outbounds": [outbound, {"type": "direct", "tag": "direct"}],
        "route": {"rules": [], "final": "proxy", "auto_detect_interface": True}
    }, indent=2)

# ─── Engine Management ───────────────────────────────────────────────────────
def start_engine(engine: str, config_file: str, container_name: str, node: str) -> None:
    img = XRAY_IMAGE if engine == "xray" else SINGBOX_IMAGE
    mount_path = "/etc/xray/config.json" if engine == "xray" else "/etc/sing-box/config.json"
    
    if node == "server-100":
        run_cmd(["docker", "rm", "-f", container_name])
        run_cmd(["docker", "run", "--rm", "-d", "--name", container_name, "--network", "host", "-v", f"{config_file}:{mount_path}:ro", img])
    elif node == "mac":
        ssh_cmd = ["ssh", "-n", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no"] + SSH_HOSTS["mac"].split()
        run_cmd(ssh_cmd + ["mkdir", "-p", "/tmp/probe"])
        run_cmd(["scp", "-o", "ConnectTimeout=5", "-P", "2222", config_file, "user@localhost:/tmp/probe/config.json"])
        run_cmd(ssh_cmd + ["bash", "-c", f"pkill -f '{engine}.*probe' 2>/dev/null; nohup {engine} run -c /tmp/probe/config.json >/dev/null 2>&1 &"])
    else:
        ssh_target = SSH_HOSTS.get(node, node)
        ssh_cmd = ["ssh", "-n", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no", ssh_target]
        run_cmd(ssh_cmd + ["bash", "-c", f"docker rm -f {container_name} >/dev/null 2>&1; mkdir -p /tmp/probe"])
        run_cmd(["scp", config_file, f"{ssh_target}:/tmp/probe/config.json"])
        run_cmd(ssh_cmd + ["docker", "run", "--rm", "-d", "--name", container_name, "--network", "host", "-v", f"/tmp/probe/config.json:{mount_path}:ro", img])

def stop_engine(engine: str, container_name: str, node: str) -> None:
    if node == "server-100":
        run_cmd(["docker", "rm", "-f", container_name])
    elif node == "mac":
        ssh_cmd = ["ssh", "-n", "-o", "ConnectTimeout=5"] + SSH_HOSTS["mac"].split()
        run_cmd(ssh_cmd + ["bash", "-c", f"pkill -f '{engine}.*probe' 2>/dev/null"])
    else:
        ssh_target = SSH_HOSTS.get(node, node)
        ssh_cmd = ["ssh", "-n", "-o", "ConnectTimeout=5", ssh_target]
        run_cmd(ssh_cmd + ["bash", "-c", f"docker rm -f {container_name} >/dev/null 2>&1"])

def node_reachable(node: str) -> bool:
    if node == "server-100": return True
    ssh_target = SSH_HOSTS.get(node, node)
    res = run_cmd(["ssh", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no", ssh_target, "echo ok"])
    return res.returncode == 0

def get_node_ip(node: str) -> str:
    if node == "server-100":
        res = run_cmd(["curl", "-s", "--max-time", "5", "https://ifconfig.me"])
        return res.stdout.strip() or "unknown"
    ssh_target = SSH_HOSTS.get(node, node)
    res = run_cmd(["ssh", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no", ssh_target, "curl -s --max-time 5 https://ifconfig.me"])
    return res.stdout.strip() or "unknown"

# ─── Core Logic ──────────────────────────────────────────────────────────────
def fetch_subscription(subscription_url: str) -> str:
    if subscription_url:
        res = run_cmd(["curl", "-sf", subscription_url], timeout=30)
        return res.stdout.strip()
    try:
        psql_cmd = ["sudo", "-u", "postgres", "psql", "-t", "-A", "-d", "vpn_panel", "-c", "SELECT token FROM subscription_tokens WHERE enabled=true ORDER BY created_at DESC LIMIT 1"]
        token = run_cmd(psql_cmd, timeout=15).stdout.strip()
        if not token: return ""
        res = run_cmd(["curl", "-sf", f"http://127.0.0.1:3129/sub/{token}/plain"], timeout=30)
        return res.stdout.strip()
    except Exception:
        return ""

def test_endpoint(ep: Dict[str, Any], engine: str, node: str, socks_port: int, timeout: int, sites: List[str], *, fingerprint: str = "", fragment: bool = False, noises: bool = False, variation_label: str = "") -> Dict[str, Any]:
    id_, address, port = ep["id"], ep["address"], ep["port"]
    label = f" [{variation_label}]" if variation_label else ""
    log(f"Testing endpoint: {BOLD}{id_}{label}{NC} ({address}:{port}) via {engine}")
    
    result: Dict[str, Any] = {"id": id_}
    if variation_label:
        result["fingerprint"] = fingerprint
        result["fragment"] = fragment
        result["noises"] = noises
    
    # 1. TCP Reachability
    try:
        with socket.create_connection((address, port), timeout=5):
            result["tcp_reachable"] = True
            ok("TCP reachable")
    except Exception:
        result["tcp_reachable"] = False
        fail("TCP unreachable")
        
    if not result["tcp_reachable"]:
        result.update({"tunnel_up": False, "exit_ip": "", "sites": [], "speed_mbps": 0, "large_transfer_mbps": 0, "large_transfer_ok": False})
        return result
        
    # 2. Start Engine & Test Tunnel
    config_file = f"/tmp/probe-{engine}-{id_}.json"
    container_name = f"probe-{engine}-{id_}"
    with open(config_file, "w") as f:
        if engine == "xray":
            f.write(gen_xray_config(ep, socks_port, fingerprint=fingerprint, fragment=fragment, noises=noises))
        else:
            f.write(gen_singbox_config(ep, socks_port, fingerprint=fingerprint))
        
    start_engine(engine, config_file, container_name, node)
    time.sleep(3)
    
    probe_raw = socks_curl(["--socks5-hostname", f"127.0.0.1:{socks_port}", "--max-time", "5", "-o", "/dev/null", "-w", "%{http_code}", "https://www.gstatic.com/generate_204"], node, timeout=10)
    tunnel_up = probe_raw in ("204", "200")
    result["tunnel_up"] = tunnel_up
    if tunnel_up: ok("Tunnel up")
    else: fail(f"Tunnel not responding (got: {probe_raw})")
    
    if not tunnel_up:
        stop_engine(engine, container_name, node)
        result.update({"exit_ip": "", "sites": [], "speed_mbps": 0, "large_transfer_mbps": 0, "large_transfer_ok": False})
        return result
        
    # 3. Exit IP
    exit_ip = socks_curl(["--socks5-hostname", f"127.0.0.1:{socks_port}", "-s", "--max-time", "10", "https://ifconfig.me"], node, timeout=15)
    result["exit_ip"] = exit_ip
    if exit_ip: ok(f"Exit IP: {exit_ip}")
    else: warn("Could not determine exit IP")
    
    # 4. Website Access
    sites_res = []
    for site in sites:
        raw = socks_curl(["--socks5-hostname", f"127.0.0.1:{socks_port}", "-s", "--max-time", str(timeout), "-w", "%{http_code} %{time_total}", "-o", "/dev/null", f"https://{site}"], node, timeout=timeout+5)
        if not raw: raw = "000 0"
        parts = raw.split()
        http_code = parts[0] if parts else "000"
        try:
            latency_ms = int(float(parts[1]) * 1000) if len(parts) > 1 else 0
        except ValueError:
            latency_ms = 0
            
        if http_code == "200": ok(f"{site} -> {http_code} ({latency_ms}ms)")
        elif http_code == "000": fail(f"{site} -> timeout")
        else: warn(f"{site} -> {http_code} ({latency_ms}ms)")
        
        code_int = int(http_code) if http_code.isdigit() else 0
        sites_res.append({"url": site, "http_code": code_int, "latency_ms": latency_ms})
    result["sites"] = sites_res
    
    # 5. Download Speed (2MB)
    speed_bytes = socks_curl(["--socks5-hostname", f"127.0.0.1:{socks_port}", "-s", "--max-time", "30", "-o", "/dev/null", "-w", "%{speed_download}", "https://speed.cloudflare.com/__down?bytes=2000000"], node, timeout=35)
    try:
        speed_mbps = round(float(speed_bytes or "0") * 8 / 1_000_000, 2)
    except ValueError:
        speed_mbps = 0.0
    result["speed_mbps"] = speed_mbps
    ok(f"Speed: {speed_mbps} Mbps")
    
    # 6. Large Transfer (10MB)
    large_raw = socks_curl(["--socks5-hostname", f"127.0.0.1:{socks_port}", "-s", "--max-time", "60", "-o", "/dev/null", "-w", "%{speed_download} %{http_code}", "https://speed.cloudflare.com/__down?bytes=10000000"], node, timeout=65)
    parts = (large_raw or "0 000").split()
    try:
        large_mbps = round(float(parts[0]) * 8 / 1_000_000, 2)
    except ValueError:
        large_mbps = 0.0
    large_code = parts[1] if len(parts) > 1 else "000"
    large_ok = (large_code == "200")
    
    result.update({"large_transfer_mbps": large_mbps, "large_transfer_ok": large_ok})
    if large_ok: ok(f"Large transfer: {large_mbps} Mbps (OK)")
    else: fail(f"Large transfer: {large_mbps} Mbps (HTTP {large_code})")
    
    stop_engine(engine, container_name, node)
    return result

def print_summary_table(file_path: Path) -> None:
    with open(file_path, "r") as f: data = json.load(f)
    node, engine = data["node"], data["engine"]
    print(f"\n{BOLD}=== Probe Results: {node} ({engine}) ==={NC}", file=sys.stderr)
    print(f"  {BOLD}{'ENDPOINT':<25} {'TCP':<6} {'VPN':<6} {'EXIT_IP':<16} {'SPEED':<10} {'10MB':<10} {'SITES':<8}{NC}", file=sys.stderr)
    print("  " + "-" * 83, file=sys.stderr)
    
    for ep in data["endpoints"]:
        tcp_s = f"{GREEN}Y{NC}" if ep["tcp_reachable"] else f"{RED}N{NC}"
        vpn_s = f"{GREEN}Y{NC}" if ep["tunnel_up"] else f"{RED}N{NC}"
        speed = ep["speed_mbps"]
        speed_s = f"{GREEN}{speed:.1f}{NC}" if speed > 5 else (f"{YELLOW}{speed:.1f}{NC}" if speed > 0 else f"{RED}0.0{NC}")
        large_s = f"{GREEN}{ep['large_transfer_mbps']}{NC}" if ep["large_transfer_ok"] else f"{RED}{ep['large_transfer_mbps']}{NC}"
        
        sites_ok = sum(1 for s in ep["sites"] if s["http_code"] == 200)
        sites_total = len(ep["sites"])
        sites_s = f"{GREEN}{sites_ok}/{sites_total}{NC}" if sites_ok == sites_total else (f"{YELLOW}{sites_ok}/{sites_total}{NC}" if sites_ok > 0 else f"{RED}0/{sites_total}{NC}")
        
        print(f"  {ep['id']:<25} {tcp_s}      {vpn_s}      {ep['exit_ip']:<16} {speed_s} Mbps   {large_s} Mbps   {sites_s}", file=sys.stderr)
    print("", file=sys.stderr)

# ─── Variation Helpers ─────────────────────────────────────────────────────────
def generate_variations(fingerprints: List[str], fragmentation: List[str], noises: List[str]) -> List[Dict[str, Any]]:
    """Generate all combinations of fingerprint x fragment x noise."""
    variations = []
    for fp in fingerprints:
        for frag in fragmentation:
            for noise in noises:
                variations.append({"fingerprint": fp, "fragment": frag == "on", "noises": noise == "on"})
    return variations

def print_variation_table(file_path: Path) -> None:
    """Print a comparison matrix for parameter variations."""
    with open(file_path, "r") as f:
        data = json.load(f)
    node, engine = data["node"], data["engine"]
    print(f"\n{BOLD}=== Variation Results: {node} ({engine}) ==={NC}", file=sys.stderr)

    for ep in data["endpoints"]:
        ep_id = ep["id"]
        variations = ep.get("variations", [])
        if not variations:
            # Legacy single-result endpoint
            print(f"\n  {BOLD}Endpoint: {ep_id}{NC}", file=sys.stderr)
            print(f"  (no variations)", file=sys.stderr)
            continue

        print(f"\n  {BOLD}Endpoint: {ep_id}{NC}", file=sys.stderr)
        header = f"  {'Fingerprint':<12} {'Fragment':<9} {'Noises':<7} {'Exit IP':<16} {'Sites (ok/total)':<18} {'Speed Mbps':<11}"
        print(header, file=sys.stderr)
        print("  " + "-" * (len(header) - 2), file=sys.stderr)

        for v in variations:
            fp_s = v.get("fingerprint", "chrome")
            frag_s = f"{GREEN}on{NC}" if v.get("fragment") else "off"
            noise_s = f"{GREEN}on{NC}" if v.get("noises") else "off"
            exit_ip = (v.get("exit_ip") or "")[:15]
            speed = v.get("speed_mbps", 0)
            speed_s = f"{GREEN}{speed:.1f}{NC}" if speed > 5 else (f"{YELLOW}{speed:.1f}{NC}" if speed > 0 else f"{RED}0.0{NC}")

            sites = v.get("sites", [])
            sites_ok = sum(1 for s in sites if s.get("http_code") == 200)
            sites_total = len(sites)
            sites_s = f"{GREEN}{sites_ok}/{sites_total}{NC}" if sites_ok == sites_total else (f"{YELLOW}{sites_ok}/{sites_total}{NC}" if sites_ok > 0 else f"{RED}0/{sites_total}{NC}")

            tcp_s = f"{GREEN}Y{NC}" if v.get("tcp_reachable") else f"{RED}N{NC}"
            vpn_s = f"{GREEN}Y{NC}" if v.get("tunnel_up") else f"{RED}N{NC}"

            print(f"  {fp_s:<12} {frag_s:<16} {noise_s:<14} {exit_ip:<16} {sites_s:<27} {speed_s} Mbps  tcp={tcp_s} vpn={vpn_s}", file=sys.stderr)
    print("", file=sys.stderr)

# ─── Main Execution ──────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="VPN Endpoint Probe Script")
    parser.add_argument("--node", default="server-100", help="Node to run on: server-100, mac, server-44, server-88, or auto")
    parser.add_argument("--engine", default="xray", choices=["xray", "singbox", "both"], help="Proxy engine to use")
    parser.add_argument("--subscription", default="", help="Subscription URL (or auto-fetch from local panel)")
    parser.add_argument("--timeout", type=int, default=15, help="Timeout per site in seconds")
    parser.add_argument("--endpoints", default="", help="Comma-separated endpoint ID filter")
    parser.add_argument("--fingerprints", default="firefox", help="Comma-separated fingerprints to test (default: firefox)")
    parser.add_argument("--fragmentation", default="off", help="Comma-separated: on,off (default: off)")
    parser.add_argument("--noises", default="off", help="Comma-separated: on,off (default: off)")
    parser.add_argument("--vary-params", action="store_true", help="Test all fingerprint x fragmentation x noise combinations")
    args = parser.parse_args()

    # Build variation lists
    fp_list = [f.strip() for f in args.fingerprints.split(",") if f.strip()]
    frag_list = [f.strip() for f in args.fragmentation.split(",") if f.strip()]
    noise_list = [f.strip() for f in args.noises.split(",") if f.strip()]

    if args.vary_params:
        # --vary-params uses all fingerprints and both on/off for fragment & noises
        if fp_list == ["firefox"]:
            fp_list = ["firefox", "chrome", "safari", "ios", "randomized"]
        if frag_list == ["off"]:
            frag_list = ["on", "off"]
        if noise_list == ["off"]:
            noise_list = ["on", "off"]

    variations = generate_variations(fp_list, frag_list, noise_list)
    use_variations = len(variations) > 1

    script_dir = Path(__file__).parent.resolve()
    results_dir = script_dir / "results"
    results_dir.mkdir(parents=True, exist_ok=True)
    
    log("Fetching subscription...")
    sub_text = fetch_subscription(args.subscription)
    if not sub_text:
        fail("Empty subscription")
        sys.exit(1)
        
    log("Parsing VLESS links...")
    parsed_endpoints = [ep for line in sub_text.splitlines() if (ep := parse_vless_link(line.strip()))]
    log(f"Parsed {len(parsed_endpoints)} endpoints")
    if not parsed_endpoints:
        fail("No endpoints found")
        sys.exit(1)

    if use_variations:
        log(f"Variation testing: {len(fp_list)} fingerprints x {len(frag_list)} fragment x {len(noise_list)} noises = {BOLD}{len(variations)} combos{NC}")
        
    nodes = ["server-100", "mac", "server-44", "server-88"] if args.node == "auto" else [args.node]
    engines = ["xray", "singbox"] if args.engine == "both" else [args.engine]
    endpoint_filter = args.endpoints.split(",") if args.endpoints else []
    
    for node in nodes:
        log(f"Node: {BOLD}{node}{NC}")
        if not node_reachable(node):
            warn(f"Node {node} unreachable, skipping")
            continue
        node_ip = get_node_ip(node)
        log(f"Node IP: {node_ip}")
        
        for eng in engines:
            log(f"Engine: {BOLD}{eng}{NC}")
            result_file = results_dir / f"probe-{node}-{eng}-{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
            endpoints_json = []

            for ep in parsed_endpoints:
                if endpoint_filter and ep["id"] not in endpoint_filter:
                    continue

                if use_variations:
                    ep_result: Dict[str, Any] = {"id": ep["id"], "variations": []}
                    for vi, var in enumerate(variations):
                        label = f"fp={var['fingerprint']} frag={'on' if var['fragment'] else 'off'} noise={'on' if var['noises'] else 'off'}"
                        log(f"  Variation {vi+1}/{len(variations)}: {label}")
                        vr = test_endpoint(
                            ep, eng, node, SOCKS_PORT, args.timeout, SITES,
                            fingerprint=var["fingerprint"], fragment=var["fragment"],
                            noises=var["noises"], variation_label=label
                        )
                        ep_result["variations"].append(vr)
                    endpoints_json.append(ep_result)
                else:
                    # Legacy single-test mode: use first fingerprint, no fragment/noises
                    vr = test_endpoint(ep, eng, node, SOCKS_PORT, args.timeout, SITES)
                    endpoints_json.append(vr)
            
            with open(result_file, "w") as f:
                json.dump({
                    "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "node": node,
                    "network_ip": node_ip,
                    "engine": eng,
                    "endpoints": endpoints_json
                }, f, indent=2)
            log(f"Results written to: {BOLD}{result_file}{NC}")
            if use_variations:
                print_variation_table(result_file)
            else:
                print_summary_table(result_file)
            
    log("All probes complete.")

if __name__ == "__main__":
    main()
