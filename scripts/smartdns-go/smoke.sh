#!/usr/bin/env bash
# Manual smoke test against a smartdns instance started from this checkout.
#
# Usage:  ./smoke.sh 18053 [127.0.0.1]
#
# Reads SMART_DNS_CID from env (defaults to a test cid that exists in the
# shipped test-config.json).
set -euo pipefail

DOH_PORT="${1:-18053}"
HOST="${2:-127.0.0.1}"
UDP_PORT="${3:-15353}"
CID="${SMART_DNS_CID:-f478b9a8a7759c4879ae98c4af41c402eb20c1a1d1b7ab75}"

python3 - "$HOST" "$DOH_PORT" "$UDP_PORT" "$CID" <<'PY'
import socket, struct, sys, urllib.request, json

HOST, DOH_PORT, UDP_PORT, CID = sys.argv[1:5]

def make_query(name, qtype=1, txid=0x1234):
    labels = b""
    for p in name.rstrip(".").split("."):
        labels += bytes([len(p)]) + p.encode()
    labels += b"\x00"
    return struct.pack("!HHHHHH", txid, 0x0100, 1, 0, 0, 0) + labels + struct.pack("!HH", qtype, 1)

def post_doh(body):
    req = urllib.request.Request(
        f"http://{HOST}:{DOH_PORT}/dns-query/{CID}",
        data=body,
        headers={"Content-Type": "application/dns-message", "Accept": "application/dns-message"},
        method="POST",
    )
    return urllib.request.urlopen(req, timeout=10).read()

def query_udp(body):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(10)
    s.sendto(body, (HOST, int(UDP_PORT)))
    b, _ = s.recvfrom(4096)
    return b

def parse(b):
    txid, flags, qd, an, *_ = struct.unpack("!HHHHHH", b[:12])
    rcode = flags & 0xF
    out = {"rcode": rcode, "an": an, "answers": []}
    off = 12
    for _ in range(qd):
        while off < len(b) and b[off] != 0: off += 1 + b[off]
        off += 5
    for _ in range(an):
        if b[off] & 0xC0:
            off += 2
        else:
            while off < len(b) and b[off] != 0: off += 1 + b[off]
            off += 1
        typ, cls, ttl, rdlen = struct.unpack("!HHIH", b[off:off+10]); off += 10
        data = b[off:off+rdlen]; off += rdlen
        if typ == 1 and rdlen == 4:
            out["answers"].append(".".join(str(x) for x in data))
        elif typ == 28 and rdlen == 16:
            out["answers"].append(":".join(data[i:i+2].hex() for i in range(0,16,2)))
        else:
            out["answers"].append(f"type{typ}={data.hex()}")
    return out

cases = [
    ("chatgpt.com",            "DoH smart-edge synth", lambda n: "212.192.31.128" in str(parse(post_doh(make_query(n))))),
    ("ya.ru",                  "DoH .ru direct",        lambda n: parse(post_doh(make_query(n)))["an"] > 0),
    ("vpn2.bezrabotnyi.com",   "DoH directDomain",      lambda n: parse(post_doh(make_query(n)))["an"] > 0),
    ("github.com",             "DoH hard-direct",       lambda n: parse(post_doh(make_query(n)))["an"] > 0),
    ("ifconfig.me",            "DoH default-route",     lambda n: parse(post_doh(make_query(n)))["an"] > 0),
    ("chatgpt.com",            "UDP smart-edge synth",  lambda n: "212.192.31.128" in str(parse(query_udp(make_query(n))))),
    ("ya.ru",                  "UDP .ru direct",        lambda n: parse(query_udp(make_query(n)))["an"] > 0),
    ("vpn2.bezrabotnyi.com",   "UDP directDomain",      lambda n: parse(query_udp(make_query(n)))["an"] > 0),
    ("github.com",             "UDP hard-direct",       lambda n: parse(query_udp(make_query(n)))["an"] > 0),
    ("ifconfig.me",            "UDP default-route",     lambda n: parse(query_udp(make_query(n)))["an"] > 0),
]

print(f"smartdns smoke: HOST={HOST} DoH=:${DOH_PORT} UDP=:${UDP_PORT} CID={CID[:8]}…")
fail = 0
for name, label, ok in cases:
    try:
        passed = ok(name)
        print(f"  {'OK ' if passed else 'FAIL'}  {label:26s} {name}")
        if not passed: fail += 1
    except Exception as e:
        print(f"  ERR  {label:26s} {name}: {e}")
        fail += 1

# edge-auth-debug
try:
    req = urllib.request.Request(f"http://{HOST}:{DOH_PORT}/edge-auth-debug",
                                 headers={"X-Edge-Auth-Token": "test-token"})
    body = json.loads(urllib.request.urlopen(req, timeout=5).read().decode())
    print(f"  {'OK ' if body.get('ok') else 'FAIL'}  edge-auth-debug           ({len(body.get('allowed',[]))} IPs / {len(body.get('maps',[]))} maps)")
except Exception as e:
    print(f"  ERR  edge-auth-debug: {e}")
    fail += 1

sys.exit(fail)
PY
