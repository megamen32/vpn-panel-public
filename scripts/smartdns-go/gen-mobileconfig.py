#!/usr/bin/env python3
"""
gen-mobileconfig.py — emit a macOS Encrypted DNS (DoH) profile.

macOS Sequoia (15+) can also install this via Settings → General →
VPN & DNS → + Add Encrypted DNS, which saves installing the .mobileconfig
file. But the .mobileconfig is the universal option: it works on all
macOS 12+ and on iOS / iPadOS, and it auto-deploys to every network the
device joins (Wi-Fi, Ethernet, Personal Hotspot, USB tethering).

usage:
  ./gen-mobileconfig.py <client-id>                            # → stdout
  ./gen-mobileconfig.py <client-id> > SmartDNS.mobileconfig    # → file
  ./gen-mobileconfig.py --server https://dns.example.com <cid>  # custom base
  ./gen-mobileconfig.py --fallback <cid>                       # allow plaintext
                                                              # fallback (helpful on 4G)

Then either:
  • open SmartDNS.mobileconfig  (macOS / iOS show installer)
  • or Settings → Profiles → install

For iOS you can also AirDrop the file directly to the device.
"""
import argparse
import plistlib
import sys
import uuid


def build_profile(client_id: str, server_url: str, allow_fallback: bool,
                  display_name: str = "SmartDNS DoH") -> dict:
    payload_uuid = str(uuid.uuid4()).upper()
    parent_uuid  = str(uuid.uuid4()).upper()

    body = {
        "PayloadContent": [{
            "PayloadType":        "com.apple.systempreferences.dnssettings.managed",
            "PayloadVersion":     1,
            "PayloadIdentifier":  f"com.bezrabotnyi.smartdns.doh.{payload_uuid[:8]}",
            "PayloadUUID":        payload_uuid,
            "PayloadDisplayName": display_name,
            "DNSSettings": {
                "DNSProtocol": "HTTPS",
                "ServerURL":   server_url,
            },
        }],
        "PayloadDisplayName": display_name,
        "PayloadIdentifier":  f"com.bezrabotnyi.smartdns.{parent_uuid[:8]}",
        "PayloadUUID":        parent_uuid,
        "PayloadType":        "Configuration",
        "PayloadVersion":     1,
    }

    # Optional: allow fallback to cleartext DNS if the cellular network
    # blocks port 443 to dns.bezrabotnyi.com. Without this, the device
    # refuses to resolve anything when DoH fails.
    if allow_fallback:
        body["PayloadContent"][0]["DNSSettings"]["AllowFallback"] = True

    return body


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("client_id", help="smartdns client id (cid)")
    ap.add_argument("--server", default="https://dns.bezrabotnyi.com",
                    help="base URL of the DoH endpoint "
                         "(default https://dns.bezrabotnyi.com)")
    ap.add_argument("--name", default="SmartDNS DoH",
                    help="display name of the profile")
    ap.add_argument("--fallback", action="store_true",
                    help="allow plaintext DNS fallback when DoH is unreachable "
                         "(recommended on hostile 4G networks)")
    args = ap.parse_args()

    if not args.client_id.strip():
        ap.error("client_id is required")

    base = args.server.rstrip("/")
    server_url = f"{base}/dns-query/{args.client_id.strip()}"

    profile = build_profile(args.client_id, server_url, args.fallback, args.name)
    plistlib.dump(profile, sys.stdout.buffer)
    return 0


if __name__ == "__main__":
    sys.exit(main())
