#!/usr/bin/env python3
"""Exercise the local artifact handoff performed by the SSH wrapper."""

import json
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class RunNetworkArtifactHandoffTest(unittest.TestCase):
    """Verify that only managed local results are handed back to telemetry."""

    def run_wrapper(
        self,
        managed: bool,
        telemetry_key: str | None = "test-key",
        dotenv_key: str | None = None,
    ) -> tuple[subprocess.CompletedProcess[str], bytes, str]:
        """Run an isolated wrapper copy and return its result, payload, and curl arguments."""
        with tempfile.TemporaryDirectory() as temporary:
            project = Path(temporary)
            scripts = project / "scripts"
            testing = project / "vpn-testing"
            tools = project / "tools"
            scripts.mkdir()
            testing.mkdir()
            tools.mkdir()
            results_dir = testing / "results" if managed else project / "external-results"
            shutil.copy2(ROOT / "scripts" / "run-network-test.sh", scripts / "run-network-test.sh")
            if dotenv_key is not None:
                (project / ".env").write_text(f"TELEMETRY_API_KEY={dotenv_key}\n", encoding="utf-8")
            (testing / "test-plan.json").write_text(json.dumps({"testTargets": [{
                "id": "lan-server44", "runner": "ssh", "sshHost": "runner@example.test",
                "sshPort": 22, "mode": "docker", "engine": "xray",
            }]}), encoding="utf-8")
            remote_result = project / "remote-result.json"
            remote_result.write_text(json.dumps({
                "schemaVersion": 1,
                "runId": "run-local-artifact",
                "profile": "quick",
                "target": {
                    "id": "lan-server44", "networkClass": "lan", "client": "xray",
                    "accessMethod": "socks-proxy", "wireMethod": "wire-internal", "hostRole": "server-44",
                },
                "engine": "xray-docker",
                "startedAt": "2026-08-11T09:00:00Z",
                "finishedAt": "2026-08-11T09:01:00Z",
                "endpoints": [],
                "summary": {"total": 1, "eligible": 1, "errors": 0},
                "networkChecks": {},
            }), encoding="utf-8")
            capture = project / "handoff.json"
            capture_args = project / "handoff-args.txt"
            self._write_tool(tools / "ssh", "#!/bin/sh\nexit 0\n")
            self._write_tool(tools / "scp", "#!/bin/sh\nlast=''\nfor arg do last=$arg; done\ncase \"$last\" in *:*) exit 0 ;; esac\ncp \"$RESULT_JSON\" \"$last\"\n")
            self._write_tool(tools / "curl", "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CAPTURE_ARGS\"\ncat > \"$CAPTURE\"\n")
            environment = {
                **os.environ,
                "PATH": f"{tools}:{os.environ['PATH']}",
                "RESULT_JSON": str(remote_result),
                "CAPTURE": str(capture),
                "CAPTURE_ARGS": str(capture_args),
                "RESULTS_DIR": str(results_dir),
                "VPN_TOKEN": "test-token",
                "TELEMETRY_URL": "https://telemetry.example.test/events",
                "RENDER_TEST_PLAN": "0",
            }
            for key in ("TELEMETRY_API_KEY", "HEALTH_API_KEY", "VPN_PANEL_HEALTH_API_KEY"):
                environment.pop(key, None)
            if telemetry_key is not None:
                environment["TELEMETRY_API_KEY"] = telemetry_key
            result = subprocess.run(
                ["bash", str(scripts / "run-network-test.sh"), "--profile=quick", "--target=lan-server44"],
                cwd=project,
                env=environment,
                text=True,
                capture_output=True,
                check=False,
            )
            return result, capture.read_bytes() if capture.exists() else b"", capture_args.read_text(encoding="utf-8") if capture_args.exists() else ""

    @staticmethod
    def _write_tool(path: Path, content: str) -> None:
        """Write one fake transport binary used by the isolated wrapper test."""
        path.write_text(content, encoding="utf-8")
        path.chmod(path.stat().st_mode | stat.S_IXUSR)

    def test_managed_result_path_posts_a_same_run_artifact_handoff(self) -> None:
        """A copied result in vpn-testing/results posts its local artifact path."""
        result, capture, curl_args = self.run_wrapper(managed=True)

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(capture)
        self.assertEqual(payload["runId"], "run-local-artifact")
        self.assertEqual(payload["type"], "run_finished")
        self.assertEqual(payload["sequence"], 2_000_000_000)
        self.assertEqual(payload["payload"]["artifactPath"], result.stdout.strip())
        self.assertIn("/vpn-testing/results/", payload["payload"]["artifactPath"])
        self.assertIn("Authorization: Bearer test-key", curl_args)

    def test_managed_result_loads_the_existing_dotenv_telemetry_key(self) -> None:
        """A configured .env key authenticates local handoff without printing the key."""
        result, capture, curl_args = self.run_wrapper(
            managed=True,
            telemetry_key=None,
            dotenv_key="dotenv-test-key",
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(capture)["runId"], "run-local-artifact")
        self.assertIn("Authorization: Bearer dotenv-test-key", curl_args)
        self.assertNotIn("dotenv-test-key", result.stdout + result.stderr)

    def test_managed_result_fails_clearly_without_a_telemetry_key(self) -> None:
        """A managed handoff requires a configured key rather than silently posting unauthenticated."""
        result, capture, curl_args = self.run_wrapper(managed=True, telemetry_key=None)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("required for local artifact handoff", result.stderr)
        self.assertEqual(capture, b"")
        self.assertEqual(curl_args, "")

    def test_external_result_path_does_not_post_an_unservable_handoff(self) -> None:
        """A copied result outside managed roots never advertises an artifact handoff."""
        result, capture, curl_args = self.run_wrapper(managed=False)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(capture, b"")
        self.assertEqual(curl_args, "")


if __name__ == "__main__":
    unittest.main()
