#!/usr/bin/env python3
"""Regression tests for orchestration shell and health-policy contracts."""

import importlib.util
import inspect
import os
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]


def load_health_module():
    """Load the hyphenated health CLI as a testable Python module."""
    path = ROOT / "scripts" / "apply-endpoint-health.py"
    spec = importlib.util.spec_from_file_location("apply_endpoint_health", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AutomationScriptsTest(unittest.TestCase):
    """Protect target isolation and health publication ordering."""

    def test_contractual_endpoints_are_unconditionally_included_by_default(self) -> None:
        module = load_health_module()
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(module.always_include_endpoints(), ["ru-full-relay", "fi-helsinki-relay"])

    def test_total_probe_failure_falls_back_only_to_public_products(self) -> None:
        module = load_health_module()
        run = {"endpoints": [{"endpoint": "de-xhttp", "eligible": False}]}
        self.assertEqual(module.eligible_relays(run), module.CANONICAL_RELAYS)
        self.assertNotIn("de-xhttp", module.eligible_relays(run))

    def test_legacy_fallbacks_are_preserved_for_every_user(self) -> None:
        module = load_health_module()
        self.assertIn("de-direct", module.LEGACY_FALLBACK_ENDPOINTS)
        self.assertIn("us-xhttp-h2-443", module.LEGACY_FALLBACK_ENDPOINTS)
        self.assertIn("us-xhttp-h2", module.LEGACY_FALLBACK_ENDPOINTS)

    def test_profile_apply_never_deletes_an_endpoint_it_did_not_manage(self) -> None:
        module = load_health_module()
        source = inspect.getsource(module.apply_profiles)
        # A blanket delete turns "this run could not probe it" into "stop
        # serving it", which is how the Hysteria2 endpoints were deleted from
        # every client profile minutes after they shipped: they are absent from
        # the probe surface, so they never appear in `working`.
        self.assertNotIn("delete from client_profiles;", source)
        self.assertIn("where endpoint_id = any(string_to_array(:'managed', ','))", source)
        # The deletion scope must cover everything the inserts repopulate,
        # otherwise a surviving row collides with its own reinsertion.
        self.assertIn("*working", source)
        self.assertIn("*always_include", source)
        self.assertIn("*LEGACY_FALLBACK_ENDPOINTS", source)

    def test_public_catalog_products_survive_any_health_run(self) -> None:
        module = load_health_module()
        script = (ROOT / "scripts" / "apply-endpoint-health.py").read_text(encoding="utf-8")
        # Public products are declared by data, so protection reads the endpoint
        # flag instead of repeating endpoint ids that go stale.
        self.assertIn("public_catalog", script)
        self.assertIn("public_catalog_endpoints(database_url)", script)
        self.assertIn("config->>'public_catalog'", script)

    def test_profile_apply_fails_loudly_instead_of_reporting_a_rollback_as_success(self) -> None:
        module = load_health_module()
        source = inspect.getsource(module.apply_profiles)
        self.assertIn("ON_ERROR_STOP=1", source)
        # Each insert draws from overlapping sets, so every one must tolerate
        # a row that an earlier clause already created.
        self.assertEqual(source.count("on conflict do nothing"), 4)

    def test_remote_spool_default_is_target_local(self) -> None:
        script = (ROOT / "scripts" / "run-network-test.sh").read_text(encoding="utf-8")
        self.assertIn('remote_spool_dir="/tmp/vpn-panel-telemetry-spool"', script)
        self.assertIn('VPN_TEST_TELEMETRY_DISABLED:$telemetry_disabled', script)
        self.assertNotIn('TELEMETRY_SPOOL_DIR:-$HOME/.local/state', script)

    def _run_with_catalog(self, module, catalog, measured):
        run = {"endpointSelection": {"catalog": catalog, "subscriptionAvailable": catalog},
               "endpoints": measured}
        return module.health_payload(run, {})

    def test_every_enabled_endpoint_is_measured_or_reported_as_unmeasured(self) -> None:
        """An enabled endpoint the run could not measure must not just vanish."""
        module = load_health_module()
        payload = self._run_with_catalog(
            module,
            ["smart-de-relay", "us-grpc", "us-xhttp"],
            [{"endpoint": "smart-de-relay", "eligible": True, "checks": []}],
        )
        self.assertEqual([row["endpoint"] for row in payload["results"]], ["smart-de-relay"])
        self.assertEqual([row["endpoint"] for row in payload["unmeasured"]], ["us-grpc", "us-xhttp"])

    def test_unmeasured_endpoint_is_reported_and_never_written_as_a_verdict(self) -> None:
        """Writing a zeroed counter would refresh checked_at and fake freshness."""
        module = load_health_module()
        payload = self._run_with_catalog(module, ["us-grpc"], [])
        self.assertEqual(payload["results"], [])
        self.assertTrue(payload["unmeasured"][0]["stale"])
        self.assertEqual(payload["unmeasured"][0]["reason"], "not-selected-for-this-run")

    def test_endpoint_missing_from_the_probe_document_is_named_as_such(self) -> None:
        """An endpoint the probe subscription cannot express is a coverage gap."""
        module = load_health_module()
        run = {"endpointSelection": {"catalog": ["us-grpc"], "subscriptionAvailable": []},
               "endpoints": []}
        payload = module.health_payload(run, {})
        self.assertEqual(payload["results"], [])
        self.assertEqual(payload["unmeasured"][0]["reason"], "absent-from-probe-subscription")

    def test_verdict_uses_a_window_so_one_transient_failure_does_not_condemn(self) -> None:
        """A single failure inside a healthy window must not fail the endpoint."""
        module = load_health_module()
        run = {"endpointSelection": {"catalog": ["de-cdn"]},
               "endpoints": [{"endpoint": "de-cdn", "eligible": True, "checks": []}]}
        window = {"de-cdn": {"passed": 34, "observations": 35, "last_at": "2026-10-09T01:42:26Z"}}
        row = module.health_payload(run, window)["results"][0]
        self.assertEqual((row["pass"], row["fail"]), (34, 1))
        self.assertGreaterEqual(row["pass"], row["fail"])
        self.assertFalse(row["stale"])

    def test_verdicts_declare_that_they_come_from_a_tunnel(self) -> None:
        """A socket probe is not evidence of a working tunnel."""
        module = load_health_module()
        payload = self._run_with_catalog(
            module, ["de-cdn"], [{"endpoint": "de-cdn", "eligible": True, "checks": []}])
        self.assertEqual(payload["results"][0]["method"], "tunnel")

    def test_measurement_only_mode_still_publishes_verdicts(self) -> None:
        """The scheduled unit runs with profile application off; it must still write."""
        script = (ROOT / "scripts" / "auto-endpoint-check.sh").read_text(encoding="utf-8")
        branch = script.split('HEALTH_APPLY_PROFILES:-1}" == 0')[1].split("exit 0")[0]
        self.assertIn("publish_health", branch)
        self.assertNotIn("--apply-profiles", branch)

    def test_run_reports_endpoints_that_received_no_measurement(self) -> None:
        """Coverage gaps belong in the artifact, not in a silently short probe set."""
        runner = (ROOT / "vpn-testing" / "unified_runner.py").read_text(encoding="utf-8")
        self.assertIn('"unmeasured"', runner)
        self.assertIn("absent-from-probe-subscription", runner)

    def test_health_is_published_before_policy_can_restart_panel(self) -> None:
        script = (ROOT / "scripts" / "auto-endpoint-check.sh").read_text(encoding="utf-8")
        post = script.index("/api/admin/endpoint-health")
        apply_profiles = script.index("--apply-profiles")
        self.assertLess(post, apply_profiles)
        self.assertIn("--retry-connrefused", script)
        self.assertIn("DIAGNOSTIC_SUBSCRIPTION=1", script)


if __name__ == "__main__":
    unittest.main()
