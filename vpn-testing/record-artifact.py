#!/usr/bin/env python3
"""Replay a real benchmark artifact into existing telemetry without duplicate samples."""
import json
import os
from pathlib import Path
import sys
import urllib.request
import uuid
from datetime import datetime, timezone


def artifact_events(result, artifact_path, include_measurements=True):
    base = {
        'schemaVersion': 1, 'runId': result['runId'], 'profile': result['profile'],
        'target': result['target'], 'type': 'run_finished',
        'timestamp': result.get('finishedAt') or datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'payload': {'summary': result['summary'], 'networkChecks': result.get('networkChecks', {}),
                    'artifactPath': str(Path(artifact_path).resolve())},
    }
    events = []
    if include_measurements:
        for endpoint in result['endpoints']:
            for check in endpoint.get('checks', []):
                events.append(dict(base, type='stage_finished', endpoint=endpoint['endpoint'],
                                   stage=check['id'], payload=check))
            events.append(dict(base, type='endpoint_finished', endpoint=endpoint['endpoint'],
                               payload={'eligible': endpoint.get('eligible', False), 'error': endpoint.get('error')}))
    events.append(base)
    # Preserve the original adapter's IDs and sequence numbers on replay.
    for offset, event in enumerate(events):
        event['sequence'] = 2_000_000_000 + offset
        event['eventId'] = str(uuid.uuid5(uuid.NAMESPACE_URL, result['runId'] + ':' + str(event['sequence'])))
    if include_measurements:
        extra = 0
        for endpoint in sorted(result['endpoints'], key=lambda item: item['endpoint']):
            for stage in ('preflight', 'udp', 'throughput'):
                payload = endpoint.get(stage)
                if not isinstance(payload, dict):
                    continue
                key = f"{result['runId']}:artifact-extension:{endpoint['endpoint']}:{stage}"
                events.append(dict(base, type='stage_finished', endpoint=endpoint['endpoint'],
                                   stage=stage, payload=payload, sequence=2_100_000_000 + extra,
                                   eventId=str(uuid.uuid5(uuid.NAMESPACE_URL, key))))
                extra += 1
    return events


def main():
    path = Path(sys.argv[1]).resolve()
    result = json.loads(path.read_text())
    events = artifact_events(result, path, os.environ.get('REMOTE_TELEMETRY_DISABLED', '1') == '1')
    for event in events:
        request = urllib.request.Request(os.environ.get('LOCAL_TELEMETRY_URL', 'http://127.0.0.1:30129/api/telemetry/vpn-tests/events'),
            data=json.dumps(event).encode(), headers={'Authorization': 'Bearer ' + os.environ['TELEMETRY_API_KEY'],
            'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=10) as response:
            if not 200 <= response.status < 300:
                raise SystemExit('Telemetry delivery failed; artifact retained')
    print(f'Local telemetry events delivered: {len(events)}', file=sys.stderr)


if __name__ == '__main__':
    main()
