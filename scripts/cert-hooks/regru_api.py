#!/usr/bin/env python3
"""
reg.ru DNS API helper for Let's Encrypt DNS-01 challenge.
Runs on server-100 (which has whitelisted IP for reg.ru API).

Env:
  REGRU_ACTION: "auth" (add TXT) | "cleanup" (remove TXT)
  REGRU_SUBDOMAIN: e.g. "_acme-challenge.vusa"
  REGRU_VALUE: ACME validation token (the TXT record content)

Exit: 0 on success, 1 on failure.
"""

import json
import os
import sys
import urllib.parse
import urllib.request

API_URL = "https://api.reg.ru/api/regru2"
USERNAME = "careviolan@gmail.com"
PASSWORD = "83tR1_u0"
ZONE = "bezrabotnyi.com"


def api_post(path: str, payload: dict) -> dict:
    encoded = urllib.parse.urlencode({
        "input_format": "json",
        "input_data": json.dumps(payload),
    }).encode("utf-8")
    request = urllib.request.Request(
        f"{API_URL}/{path}",
        data=encoded,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> int:
    action = os.environ.get("REGRU_ACTION", "").strip()
    subdomain = os.environ.get("REGRU_SUBDOMAIN", "").strip()
    value = os.environ.get("REGRU_VALUE", "").strip()

    if not (action and subdomain and value):
        print("Usage: REGRU_ACTION={auth|cleanup} REGRU_SUBDOMAIN=<sub> REGRU_VALUE=<token> "
              "python3 regru_api.py", file=sys.stderr)
        return 1

    if action == "auth":
        payload = {
            "username": USERNAME,
            "password": PASSWORD,
            "domains": [{"dname": ZONE}],
            "subdomain": subdomain,
            "text": value,
            "output_content_type": "plain",
        }
        result = api_post("zone/add_txt", payload)
    elif action == "cleanup":
        payload = {
            "username": USERNAME,
            "password": PASSWORD,
            "domains": [{"dname": ZONE}],
            "subdomain": subdomain,
            "content": value,
            "record_type": "TXT",
            "output_content_type": "plain",
        }
        result = api_post("zone/remove_record", payload)
    else:
        print(f"Unknown REGRU_ACTION: {action}", file=sys.stderr)
        return 1

    print(json.dumps(result))
    return 0 if result.get("result") == "success" else 1


if __name__ == "__main__":
    sys.exit(main())
