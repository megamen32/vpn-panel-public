import importlib.util
from pathlib import Path
import unittest
import uuid

spec = importlib.util.spec_from_file_location('record_artifact', Path(__file__).with_name('record-artifact.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ArtifactTelemetryTest(unittest.TestCase):
    def test_replay_preserves_original_ids_and_adds_speed_without_duplicate_endpoint_results(self):
        result = {'runId': 'actual-run', 'profile': 'benchmark', 'target': {}, 'summary': {},
                  'finishedAt': '2026-09-16T13:00:00Z', 'endpoints': [{
                      'endpoint': 'de-cdn', 'eligible': True, 'checks': [{'id': 'telegram', 'latencyMs': 400}],
                      'throughput': {'ok': True, 'mbps': 25.5}, 'udp': {'ok': False}}]}
        events = module.artifact_events(result, '/var/lib/result.json')
        self.assertEqual(len([e for e in events if e['type'] == 'endpoint_finished']), 1)
        for offset in range(3):
            self.assertEqual(events[offset]['eventId'], str(uuid.uuid5(uuid.NAMESPACE_URL, f'actual-run:{2_000_000_000 + offset}')))
        speed = next(e for e in events if e.get('stage') == 'throughput')
        self.assertEqual(speed['payload']['mbps'], 25.5)
        self.assertEqual(events, module.artifact_events(result, '/var/lib/result.json'))
        self.assertEqual(len({e['eventId'] for e in events}), len(events))
        self.assertTrue(all(e['sequence'] < 2_147_483_647 for e in events))


if __name__ == '__main__':
    unittest.main()
