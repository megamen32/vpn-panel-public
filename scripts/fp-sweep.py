#!/usr/bin/env python3
"""
Sweep uTLS fingerprints against a Reality endpoint and report which one works.

The end goal is not "try harder until something passes" — it is to find out
whether the endpoint is blocked by fingerprint-dependent DPI (in which case a
different client fingerprint is the fix) or simply broken (in which case no
fingerprint will ever pass and the endpoint should be disabled).

Usage:
  python3 fp-sweep.py --uuid <uuid> --address <ip> --sni <name> \
      --pbk <public key> --sid <short id> [--ports 443,23443]
"""
import argparse
import importlib.util
import json
import os
import subprocess
import time

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("pe", os.path.join(HERE, "probe-external.py"))
pe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pe)

FINGERPRINTS = [
    "chrome", "firefox", "safari", "safari-ios", "ios", "edge",
    "android", "chrome-android", "360", "qq", "random", "randomized",
]


def try_one(fp, link, port, timeout):
    t = dict(link)
    t["fp"] = fp
    cfg = pe.xray_config(t, port)
    path = f"/tmp/fpsweep-{port}-{fp}.json"
    with open(path, "w") as f:
        json.dump(cfg, f)
    proc = subprocess.Popen([pe.XRAY, "run", "-c", path],
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    time.sleep(1.4)
    try:
        if proc.poll() is not None:
            return False, "start-fail"
        r = subprocess.run(["curl", "-s", "--max-time", str(timeout),
                            "-x", f"socks5h://127.0.0.1:{port}",
                            "http://httpbin.org/ip"],
                           capture_output=True, text=True, timeout=timeout + 6)
        out = (r.stdout or "").strip()
        return (r.returncode == 0 and bool(out)), out.replace("\n", " ")[:60]
    except subprocess.TimeoutExpired:
        return False, "timeout"
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=4)
        except subprocess.TimeoutExpired:
            proc.kill()
        if os.path.exists(path):
            os.unlink(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--uuid", required=True)
    ap.add_argument("--address", required=True)
    ap.add_argument("--sni", required=True)
    ap.add_argument("--pbk", required=True)
    ap.add_argument("--sid", required=True)
    ap.add_argument("--flow", default="xtls-rprx-vision")
    ap.add_argument("--ports", default="443")
    ap.add_argument("--timeout", type=int, default=14)
    args = ap.parse_args()

    link = {
        "name": "sweep", "uuid": args.uuid, "address": args.address,
        "port": int(args.ports.split(",")[0]), "type": "tcp",
        "security": "reality", "sni": args.sni, "pbk": args.pbk,
        "sid": args.sid, "fp": "chrome", "flow": args.flow,
    }

    winners = []
    for port in [int(p) for p in args.ports.split(",")]:
        print(f"--- {args.address}:{port}  sni={args.sni} ---")
        base = 0
        for fp in FINGERPRINTS:
            base += 1
            ok, detail = try_one(fp, link, 18000 + base + port, args.timeout)
            mark = "PASS" if ok else "fail"
            print(f"  {fp:<16} {mark}  {detail}")
            if ok:
                winners.append((port, fp))
        print()

    print("=" * 58)
    if winners:
        print("работающие отпечатки:", ", ".join(f"{p}:{f}" for p, f in winners))
    else:
        print("НИ ОДИН отпечаток не прошёл -> проблема не в DPI-отпечатке, "
              "эндпоинт сломан и должен быть выключен")


if __name__ == "__main__":
    main()