#!/usr/bin/env python3
"""Focused regressions for telemetry replay and final-run artifact handoff."""

import json
import os
import tempfile
import unittest
from pathlib import Path
import sys
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import unified_runner


class TelemetryLifecycleTest(unittest.TestCase):
    """Keep telemetry replay scoped and final artifacts discoverable."""

    def test_replay_pending_replays_old_managed_runs_but_leaves_foreign_json_alone(self) -> None:
        """A new run must replay managed run UUID dirs and ignore foreign JSON outside the spool root."""
        with tempfile.TemporaryDirectory() as temp_dir:
            sandbox_root = Path(temp_dir)
            telemetry_root = sandbox_root / "telemetry-spool"
            old_run_one = telemetry_root / "run-old-1"
            old_run_two = telemetry_root / "run-old-2"
            foreign_root = sandbox_root / "foreign-root"
            old_run_one.mkdir(parents=True, exist_ok=True)
            old_run_two.mkdir(parents=True, exist_ok=True)
            foreign_root.mkdir(parents=True, exist_ok=True)
            old_event_one = old_run_one / "000001-old-1.json"
            old_event_two = old_run_two / "000001-old-2.json"
            foreign_event = foreign_root / "foreign.json"
            old_event_one.write_text(json.dumps({"event": "old-1"}) + "\n", encoding="utf-8")
            old_event_two.write_text(json.dumps({"event": "old-2"}) + "\n", encoding="utf-8")
            foreign_event.write_text(json.dumps({"event": "foreign"}) + "\n", encoding="utf-8")

            with mock.patch.object(unified_runner.TelemetrySink, "_post", return_value=True) as post, \
                    mock.patch.object(unified_runner.TelemetrySink, "_upload_s3", return_value=False):
                unified_runner.TelemetrySink(
                    "run-current",
                    "health",
                    {"id": "lan-server44", "networkClass": "lan", "client": "xray", "accessMethod": "socks-proxy", "wireMethod": "wire-internal", "hostRole": "server-44"},
                    telemetry_root,
                )

            self.assertFalse(old_event_one.exists())
            self.assertFalse(old_event_two.exists())
            self.assertTrue(foreign_event.exists())
            self.assertEqual(post.call_count, 2)
            self.assertEqual({json.loads(call.args[0])["event"] for call in post.call_args_list}, {"old-1", "old-2"})

    def test_run_finished_payload_includes_saved_artifact_path(self) -> None:
        """The final telemetry payload must advertise the saved result artifact."""
        payload = unified_runner.build_run_finished_payload(
            {"total": 1, "eligible": 1, "failed": 0, "errors": 0},
            {"quic": {"ok": True}},
            Path("vpn-testing/results/unified-run.json"),
        )

        self.assertEqual(payload["artifactPath"], "vpn-testing/results/unified-run.json")
        self.assertEqual(payload["summary"], {"total": 1, "eligible": 1, "failed": 0, "errors": 0})
        self.assertEqual(payload["networkChecks"], {"quic": {"ok": True}})

    def test_disabled_telemetry_neither_replays_nor_spools_remote_events(self) -> None:
        """Remote runners rely on the local artifact handoff while public ingress is unavailable."""
        with tempfile.TemporaryDirectory() as temp_dir:
            telemetry_root = Path(temp_dir) / "telemetry-spool"
            old_event = telemetry_root / "run-old" / "000001-old.json"
            old_event.parent.mkdir(parents=True)
            old_event.write_text('{"event":"old"}\n', encoding="utf-8")
            with mock.patch.dict(os.environ, {"VPN_TEST_TELEMETRY_DISABLED": "1"}):
                with mock.patch.object(unified_runner.TelemetrySink, "_post") as post:
                    sink = unified_runner.TelemetrySink(
                        "run-current", "health",
                        {"id": "lan-server44", "networkClass": "lan", "client": "xray", "accessMethod": "socks-proxy", "wireMethod": "wire-internal", "hostRole": "server-44"},
                        telemetry_root,
                    )
                    sink.emit("stage_started", endpoint="fi-helsinki-relay", stage="preflight")

            post.assert_not_called()
            self.assertTrue(old_event.exists())
            self.assertFalse((telemetry_root / "run-current").exists())

    def test_diagnostic_subscription_uses_health_authorization(self) -> None:
        response = mock.MagicMock()
        response.__enter__.return_value = response
        with mock.patch.dict(os.environ, {"DIAGNOSTIC_SUBSCRIPTION": "1", "TELEMETRY_API_KEY": "health-key"}, clear=False), \
                mock.patch.object(unified_runner.urllib.request, "urlopen", return_value=response) as urlopen, \
                mock.patch.object(unified_runner.json, "load", return_value={"outbounds": []}):
            self.assertEqual(unified_runner._subscription("https://panel.example/sub/token/xray-json"), {"outbounds": []})

        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "https://panel.example/sub/token/xray-json?diagnostic=1")
        self.assertEqual(request.get_header("Authorization"), "Bearer health-key")


if __name__ == "__main__":
    unittest.main()
