#!/usr/bin/env python3
"""Convert physical USB Android curl measurements to the shared artifact format."""
import hashlib
import json
from pathlib import Path
import re
import sys
import uuid

path = Path(sys.argv[1]).resolve()
text = path.read_text()
started = re.search(r'^START=(.+)$', text, re.M).group(1)
finished = re.findall(r'^END=(.+)$', text, re.M)[-1]
for interface in ('wlan0', 'rmnet4'):
    endpoints = {}
    for line in text.splitlines():
        match = re.match(rf'{interface} (\S+) round=\d+ code=(\d+) time=([\d.]+)', line)
        if match:
            tag, code, elapsed = match.groups()
            entry = endpoints.setdefault(tag, {'endpoint': tag, 'checks': []})
            entry['checks'].append({'id': 'chatgpt', 'code': int(code), 'ok': code == '200',
                'contentOk': code == '200', 'reachable': code == '200', 'latencyMs': round(float(elapsed)*1000)})
        match = re.match(rf'{interface} (\S+) throughput code=(\d+) bytes=([\d.]+) speed=([\d.]+)', line)
        if match:
            tag, code, size, speed = match.groups()
            endpoints.setdefault(tag, {'endpoint': tag, 'checks': []})['throughput'] = {
                'ok': code == '200' and float(size) == 3_000_000, 'code': int(code),
                'bytes': int(float(size)), 'mbps': round(float(speed)*8/1_000_000, 2)}
    assert endpoints, f'No actual {interface} measurements'
    for entry in endpoints.values():
        entry['eligible'] = (len(entry['checks']) == 3 and all(check['ok'] for check in entry['checks'])
                             and entry.get('throughput', {}).get('ok', False))
    mobile = interface == 'rmnet4'
    target = {'id': 'external-wireless-android' if mobile else 'android-usb-wifi',
        'networkClass': 'external-mobile' if mobile else 'external-unknown', 'client': 'xray',
        'accessMethod': 'socks-proxy', 'wireMethod': '4g' if mobile else 'unknown', 'hostRole': 'android',
        'physicalTransport': 'cellular' if mobile else 'wifi', 'networkInterface': interface}
    run_id = str(uuid.uuid5(uuid.NAMESPACE_URL, hashlib.sha256(path.read_bytes()).hexdigest()+':'+interface))
    artifact = {'schemaVersion': 1, 'runId': run_id, 'profile': 'benchmark', 'target': target,
        'engine': 'xray', 'startedAt': started, 'finishedAt': finished, 'endpoints': list(endpoints.values()),
        'summary': {'total': len(endpoints), 'eligible': sum(e['eligible'] for e in endpoints.values()),
                    'failed': sum(not e['eligible'] for e in endpoints.values()), 'errors': 0}}
    output = path.with_name(path.stem+'-'+interface+'.json')
    output.write_text(json.dumps(artifact, indent=2)+'\n')
    print(output)
