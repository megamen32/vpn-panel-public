#!/usr/bin/env python3

"""Probe HTTP Basic proxy endpoints without putting credentials in argv or logs."""

from __future__ import annotations

import argparse
import base64
import json
import sys
import urllib.error
import urllib.request


def fetch(proxy: str, password: str | None) -> tuple[str, str]:
    handlers = [urllib.request.ProxyHandler({"http": proxy, "https": proxy})]
    opener = urllib.request.build_opener(*handlers)
    request = urllib.request.Request("https://api.ipify.org")
    if password is not None:
        encoded = base64.b64encode(f"roomhacker:{password}".encode()).decode()
        request.add_unredirected_header("Proxy-Authorization", f"Basic {encoded}")
    try:
        with opener.open(request, timeout=25) as response:
            return str(response.status), response.read().decode().strip()
    except urllib.error.HTTPError as error:
        return str(error.code), ""
    except Exception as error:  # Deliberately do not print potentially sensitive request details.
        return type(error).__name__, ""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--ports", nargs="+", type=int, default=[3127, 3128, 3129, 3130])
    args = parser.parse_args()

    password = sys.stdin.buffer.read().rstrip(b"\r\n")
    if not password:
        raise SystemExit("missing proxy password on stdin")
    password_text = password.decode("utf-8")

    failed = False
    for port in args.ports:
        proxy = f"http://{args.host}:{port}"
        unauth_status, _ = fetch(proxy, None)
        auth_status, exit_ip = fetch(proxy, password_text)
        record = {"host": args.host, "port": port, "unauth": unauth_status, "auth": auth_status}
        if exit_ip:
            record["exit"] = exit_ip
        print(json.dumps(record, sort_keys=True))
        failed |= auth_status != "200" or unauth_status == "200"
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
