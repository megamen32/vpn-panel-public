#!/usr/bin/env python3
"""Regression tests for the shared VPN test plan and result contract."""

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import unified_runner
from android_network import validated_cellular_interface
from unified_runner import TelemetrySink, PlanError, PortReservations, _http_check, _parser, _start_engine, cellular_bridge_endpoint_config, classify_http_response, endpoint_config, endpoint_eligible, load_plan, singbox_endpoint_config, summarize_run, validate_result


PLAN_PATH = Path(__file__).with_name("test-plan.json")
REPO_ROOT = PLAN_PATH.parent.parent


class UnifiedContractTest(unittest.TestCase):
    """Protect the common plan and cross-runner result semantics."""

    def test_profiles_are_strictly_multi_stage(self) -> None:
        plan = load_plan(PLAN_PATH)
        self.assertEqual(plan["profiles"]["quick"]["stages"], ["preflight", "gate"])
        self.assertTrue(set(plan["profiles"]["health"]["stages"]) < set(plan["profiles"]["benchmark"]["stages"]))

    def test_every_required_gate_is_declared_once(self) -> None:
        plan = load_plan(PLAN_PATH)
        ids = [check["id"] for check in plan["httpChecks"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertTrue(set(plan["eligibility"]["requiredGateChecks"]) <= set(ids))

    def test_benchmark_catalog_is_not_reduced_to_public_products(self) -> None:
        plan = load_plan(PLAN_PATH)
        self.assertGreater(len(plan["endpointCatalog"]), 4)
        self.assertEqual(plan["profiles"]["benchmark"]["parallelism"], 3)

    def test_engine_images_are_pinned(self) -> None:
        args = _parser().parse_args([])
        self.assertEqual(args.xray_image, "teddysun/xray:26.6.1")
        self.assertEqual(args.singbox_image, "ghcr.io/sagernet/sing-box:v1.13.14")

    def test_invalid_plan_fails_explicitly(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            bad_plan = Path(temp_dir) / "plan.json"
            bad_plan.write_text(json.dumps({"schemaVersion": 1, "profiles": {}}), encoding="utf-8")
            with self.assertRaises(PlanError):
                load_plan(bad_plan)

    def test_eligibility_uses_shared_gate_and_site_ratio(self) -> None:
        plan = load_plan(PLAN_PATH)
        passing = {
            "endpoint": "smart-de-relay",
            "exitIp": "212.192.31.128",
            "checks": [
                {"id": "telegram", "ok": True},
                {"id": "gstatic", "ok": True},
                {"id": "youtube", "ok": True},
                {"id": "chatgpt", "ok": True},
                {"id": "reddit", "ok": False},
            ]
        }
        failing = {"checks": [{"id": "telegram", "ok": False}]}
        self.assertTrue(endpoint_eligible(plan, passing, "health"))
        self.assertFalse(endpoint_eligible(plan, failing, "quick"))

    def test_disabled_http_targets_are_not_selected_or_required(self) -> None:
        plan = load_plan(PLAN_PATH)
        selected = unified_runner.selected_http_checks(plan, "benchmark")
        selected_ids = {str(check["id"]) for check in selected}
        self.assertNotIn("gstatic", selected_ids)
        self.assertNotIn("reddit", selected_ids)
        explicitly_selected = unified_runner.selected_http_checks(plan, "benchmark", ["telegram", "gstatic", "reddit"])
        explicitly_selected_ids = {str(check["id"]) for check in explicitly_selected}
        self.assertEqual(explicitly_selected_ids, {"telegram", "gstatic", "reddit"})
        quick_selected = unified_runner.selected_http_checks(plan, "quick", ["telegram", "gstatic", "reddit", "youtube"])
        self.assertEqual({str(check["id"]) for check in quick_selected}, {"telegram", "gstatic"})

        result = {
            "endpoint": "smart-de-relay",
            "exitIp": "212.192.31.128",
            "checks": [
                {"id": "telegram", "ok": True},
                {"id": "youtube", "ok": True},
                {"id": "chatgpt", "ok": True},
                {"id": "wikipedia", "ok": True},
            ],
        }
        self.assertTrue(endpoint_eligible(plan, result, "health"))

    def test_endpoint_runner_executes_profile_stages(self) -> None:
        plan = {
            "profiles": {"benchmark": {"stages": ["preflight", "gate", "udp", "throughput"]}},
            "udpCheck": {"id": "dns"},
            "throughput": {"url": "https://example.test", "bytes": 1, "timeoutSeconds": 1},
        }
        args = SimpleNamespace(engine="xray", xray_image="xray:test", singbox_image="singbox:test", xray_bin=None, mode="native")
        reservations = mock.Mock()
        engine = mock.Mock()
        telemetry = mock.Mock()

        with tempfile.TemporaryDirectory() as temp_dir, \
                mock.patch("unified_runner.endpoint_config", return_value={}), \
                mock.patch("unified_runner._start_engine", return_value=engine), \
                mock.patch("unified_runner._wait_socks"), \
                mock.patch("unified_runner._exit_ip", return_value="212.192.31.128"), \
                mock.patch("unified_runner._udp_check", return_value={"ok": True}), \
                mock.patch("unified_runner._throughput", return_value={"ok": True}), \
                mock.patch("unified_runner.endpoint_eligible", return_value=True):
            result = unified_runner._run_endpoint(
                plan,
                "benchmark",
                [],
                {},
                "smart-de-relay",
                0,
                11080,
                reservations,
                "run-1",
                args,
                Path(temp_dir),
                telemetry,
            )

        self.assertEqual(result["udp"], {"ok": True})
        self.assertEqual(result["throughput"], {"ok": True})
        engine.stop.assert_called_once_with()

    def test_eligibility_rejects_wrong_regional_exit(self) -> None:
        plan = load_plan(PLAN_PATH)
        result = {
            "endpoint": "full-us-relay",
            "exitIp": "212.192.31.128",
            "checks": [{"id": "telegram", "ok": True}, {"id": "gstatic", "ok": True}],
        }
        self.assertFalse(endpoint_eligible(plan, result, "quick"))

    def test_http_auth_response_is_reachable_but_timeout_is_fatal(self) -> None:
        check = {"acceptedCodes": [200]}
        self.assertEqual(classify_http_response(check, 401), {"reachable": True, "contentOk": False, "severity": "warning"})
        self.assertEqual(classify_http_response(check, 403), {"reachable": True, "contentOk": False, "severity": "warning"})
        self.assertEqual(classify_http_response(check, 0), {"reachable": False, "contentOk": False, "severity": "fatal"})

    def test_http_transport_timeout_is_a_failed_check_not_a_runner_error(self) -> None:
        check = {"id": "telegram", "label": "Telegram", "group": "gate", "url": "https://telegram.org", "acceptedCodes": [200], "timeoutSeconds": 1}
        with mock.patch("unified_runner._run", side_effect=subprocess.TimeoutExpired(["curl"], 4)):
            result = _http_check(check, 12345)

        self.assertEqual(result["code"], 0)
        self.assertFalse(result["reachable"])
        self.assertEqual(result["severity"], "fatal")
        self.assertIn("timed out", result["error"])

    def test_docker_cleanup_timeout_does_not_abort_the_health_runner(self) -> None:
        """A stuck sidecar removal must not discard completed endpoint results."""
        engine = unified_runner.EngineProcess("docker", "vpn-check-test", None, ["docker"])

        with mock.patch(
            "unified_runner._run",
            side_effect=subprocess.TimeoutExpired(["docker", "rm", "-f", "vpn-check-test"], 15),
        ):
            engine.stop()

    def test_result_summary_is_runner_independent(self) -> None:
        run = {
            "schemaVersion": 1,
            "runId": "run-1",
            "profile": "quick",
            "target": {"id": "lan-server44", "networkClass": "lan", "client": "xray", "accessMethod": "socks-proxy", "wireMethod": "wire-internal", "hostRole": "server-44"},
            "engine": "xray",
            "startedAt": "2026-07-14T00:00:00Z",
            "finishedAt": "2026-07-14T00:00:01Z",
            "endpoints": [{"endpoint": "a", "eligible": True}, {"endpoint": "b", "eligible": False}],
        }
        run["summary"] = summarize_run(run["endpoints"])
        validate_result(run)
        self.assertEqual(run["summary"], {"total": 2, "eligible": 1, "failed": 1, "errors": 0})

    def test_endpoint_config_enables_real_socks_udp(self) -> None:
        base = {
            "inbounds": [{"tag": "socks-in", "port": 1080, "protocol": "socks", "settings": {"auth": "noauth"}}],
            "outbounds": [{"tag": "de-xhttp", "protocol": "vless"}],
        }
        config = endpoint_config(base, "de-xhttp", 11080)
        self.assertEqual(config["inbounds"][0]["settings"]["udp"], True)

    def test_endpoint_config_preserves_subscription_dns_policy(self) -> None:
        base = {
            "inbounds": [{"tag": "socks-in", "port": 1080, "protocol": "socks", "settings": {"auth": "noauth"}}],
            "outbounds": [{"tag": "fi-helsinki-relay", "protocol": "vless"}],
            "dns": {"servers": [{"address": "1.1.1.1"}]},
        }

        config = endpoint_config(base, "fi-helsinki-relay", 11080)

        self.assertEqual(config["dns"], base["dns"])
        self.assertIsNot(config["dns"], base["dns"])

    def test_health_plan_uses_the_reachable_fi_udp_resolver(self) -> None:
        plan = json.loads((REPO_ROOT / "vpn-testing" / "test-plan.json").read_text(encoding="utf-8"))
        self.assertEqual(plan["udpCheck"]["host"], "8.8.8.8")

    def test_singbox_endpoint_config_converts_reality_outbound(self) -> None:
        base = {
            "inbounds": [{"tag": "socks-in", "port": 1080, "protocol": "socks", "settings": {"auth": "noauth"}}],
            "outbounds": [{
                "tag": "de-direct",
                "protocol": "vless",
                "settings": {"vnext": [{"address": "vpn2.example", "port": 443, "users": [{"id": "uuid", "flow": "xtls-rprx-vision"}]}]},
                "streamSettings": {"network": "tcp", "security": "reality", "realitySettings": {"serverName": "ya.ru", "fingerprint": "chrome", "publicKey": "public", "shortId": "short"}},
            }],
        }

        config = singbox_endpoint_config(base, "de-direct", 11080)
        outbound = config["outbounds"][0]
        self.assertEqual(config["inbounds"][0]["type"], "socks")
        self.assertEqual(config["inbounds"][0]["listen_port"], 11080)
        self.assertEqual(outbound["type"], "vless")
        self.assertEqual(outbound["tls"]["reality"]["public_key"], "public")
        self.assertEqual(outbound["tls"]["utls"]["fingerprint"], "chrome")

    def test_singbox_rejects_xhttp_outbound(self) -> None:
        base = {
            "inbounds": [{"tag": "socks-in", "port": 1080, "protocol": "socks", "settings": {"auth": "noauth"}}],
            "outbounds": [{
                "tag": "de-xhttp",
                "protocol": "vless",
                "settings": {"vnext": [{"address": "vpn2.example", "port": 443, "users": [{"id": "uuid"}]}]},
                "streamSettings": {"network": "xhttp", "security": "tls", "tlsSettings": {"serverName": "vpn2.example"}},
            }],
        }

        with self.assertRaisesRegex(PlanError, "unsupported sing-box transport"):
            singbox_endpoint_config(base, "de-xhttp", 11080)

    def test_singbox_docker_starts_the_run_command(self) -> None:
        """The official sing-box image requires an explicit run subcommand."""
        completed = subprocess.CompletedProcess(["docker"], 0, stdout="container-id\n", stderr="")
        with mock.patch("unified_runner._docker_command", return_value=["docker"]), \
                mock.patch("unified_runner._run", return_value=completed) as run, \
                mock.patch("unified_runner.time.sleep"):
            _start_engine(Path("/tmp/sing-box-test.json"), "docker", None, "sing-box:image", "test-container", "singbox")

        command = run.call_args.args[0]
        self.assertEqual(command, [
            "docker", "run", "-d", "--name", "test-container", "--network", "host",
            "-v", "/tmp/sing-box-test.json:/etc/sing-box/config.json:ro", "sing-box:image",
            "run", "-c", "/etc/sing-box/config.json",
        ])

    def test_docker_command_probe_is_reused_across_endpoints(self) -> None:
        """Parallel endpoint startup must not probe Docker repeatedly."""
        unified_runner._docker_command_cache = None
        completed = subprocess.CompletedProcess(["docker", "info"], 0, stdout="", stderr="")
        with mock.patch("unified_runner.shutil.which", return_value="/usr/bin/docker"), \
                mock.patch("unified_runner._run", return_value=completed) as run:
            first = unified_runner._docker_command()
            second = unified_runner._docker_command()

        self.assertEqual(first, ["docker"])
        self.assertEqual(second, ["docker"])
        self.assertEqual(run.call_count, 1)

    def test_android_target_requires_cellular_transport(self) -> None:
        plan = load_plan(PLAN_PATH)
        target = plan["targets"]["external-wireless-android"]
        self.assertEqual(target["networkClass"], "external-mobile")
        self.assertEqual(target["requiredTransport"], "cellular")
        self.assertEqual(target["wireMethod"], "4g")
        self.assertEqual(target["client"], "xray")

    def test_test_target_registry_places_android_on_server100(self) -> None:
        plan = load_plan(PLAN_PATH)
        targets = {target["id"]: target for target in plan["testTargets"]}
        self.assertEqual(targets["external-wireless-android"]["sshHost"], "roomhacker@192.168.2.100")
        self.assertEqual(targets["external-wireless-android"]["runner"], "android-adb")
        self.assertEqual(targets["external-wireless-android"]["adbSerial"], "R5CR702SRFP")
        for target_id, target in targets.items():
            self.assertEqual(target["planTarget"], target_id)
            self.assertIn(target["runner"], {"ssh", "android-adb"})

    def test_mac_target_does_not_claim_an_unverified_wireless_path(self) -> None:
        plan = load_plan(PLAN_PATH)
        target = plan["targets"]["external-mac"]
        self.assertEqual(target["networkClass"], "external-unknown")
        self.assertEqual(target["wireMethod"], "unknown")
        self.assertEqual(target["client"], "xray")
        self.assertEqual(target["hostRole"], "mac")

    def test_plan_endpoint_catalog_is_generated_and_has_no_disabled_nodes(self) -> None:
        plan = load_plan(PLAN_PATH)
        self.assertEqual(plan["generatedFrom"], "secure.json:nodes")
        catalog = plan["endpointCatalog"]
        self.assertTrue(catalog)
        self.assertTrue(all(item["enabled"] for item in catalog))
        self.assertEqual(set(plan["endpointExpectations"]), {item["id"] for item in catalog})

    def test_everywhere_benchmark_always_includes_android_and_telemetry(self) -> None:
        script = (REPO_ROOT / "scripts" / "run-bench-everywhere.sh").read_text(encoding="utf-8")
        self.assertIn('${HOSTS:-s44 s44-singbox-http s44-singbox-socks mac android}', script)
        self.assertIn('source "$REPO_DIR/.env"', script)
        self.assertIn('VPN_TOKEN="$(psql "$DATABASE_URL"', script)
        self.assertIn('export TELEMETRY_URL=', script)
        self.assertIn('export TELEMETRY_API_KEY=', script)
        self.assertIn('${TELEMETRY_API_KEY:?', script)

    def test_android_agent_build_discovers_the_system_sdk_on_server100(self) -> None:
        build = (REPO_ROOT / "android-test-agent" / "build.sh").read_text(encoding="utf-8")
        self.assertIn('/usr/lib/android-sdk', build)
        self.assertIn('[[ ! -f "$ANDROID_JAR" ]]', build)

    def test_android_runner_recovers_only_from_a_stale_test_agent_signature(self) -> None:
        runner = (REPO_ROOT / "scripts" / "run-android-network-test.sh").read_text(encoding="utf-8")
        self.assertIn("INSTALL_FAILED_UPDATE_INCOMPATIBLE", runner)
        self.assertIn("adb_run uninstall com.bezrabotnyi.vpntestagent", runner)

    def test_android_runner_passes_requested_checks_into_the_remote_endpoint_run(self) -> None:
        runner = (REPO_ROOT / "scripts" / "run-android-network-test.sh").read_text(encoding="utf-8")
        self.assertIn('"$cellular_interface" "$CHECKS"', runner)
        self.assertIn('checks="${13}"', runner)
        self.assertIn('if [[ "$checks" != "__PLAN_DEFAULTS__" ]]', runner)

    def test_health_matrix_includes_engine_labeled_android_and_unclassified_mac(self) -> None:
        everywhere = (REPO_ROOT / "scripts" / "run-bench-everywhere.sh").read_text(encoding="utf-8")
        network = (REPO_ROOT / "scripts" / "run-network-test.sh").read_text(encoding="utf-8")
        plan_text = (REPO_ROOT / "vpn-testing" / "test-plan.json").read_text(encoding="utf-8")
        auto = (REPO_ROOT / "scripts" / "auto-endpoint-check.sh").read_text(encoding="utf-8")
        android = (REPO_ROOT / "android-test-agent" / "src" / "com" / "bezrabotnyi" / "vpntestagent" / "VpnTestInstrumentation.java").read_text(encoding="utf-8")
        merge_android = (REPO_ROOT / "vpn-testing" / "merge_android_results.py").read_text(encoding="utf-8")

        self.assertIn('${HOSTS:-s44 s44-singbox-http s44-singbox-socks mac android}', everywhere)
        self.assertIn("lan-server44-singbox-http", plan_text)
        self.assertIn("lan-server44-singbox-socks", plan_text)
        self.assertIn("external-mac", plan_text)
        self.assertNotIn("external-4g-mac", everywhere)
        self.assertIn('"engine": "singbox"', plan_text)
        self.assertIn('--engine "$engine"', network)
        self.assertIn('plan["testTargets"]', network)
        self.assertNotIn('roomhacker@192.168.2.5)', network)
        self.assertIn('--adb-host=$remote', network)
        self.assertIn('ADB_HOST="${ANDROID_ADB_HOST:-roomhacker@192.168.2.100}"', (REPO_ROOT / "scripts" / "run-android-network-test.sh").read_text(encoding="utf-8"))
        self.assertIn('"client", "xray"', android)
        self.assertIn('"wireMethod", "4g"', android)
        self.assertIn('"engine": "xray-android-shell"', merge_android)
        self.assertIn('PROFILE="${PROFILE:-health}"', auto)
        self.assertIn('HOSTS="${HEALTH_TEST_HOSTS:-s44 s44-singbox-http s44-singbox-socks mac android}"', auto)
        self.assertIn("run-bench-everywhere.sh", auto)
        self.assertIn("matrix_status=$?", auto)
        self.assertIn("No server-44 Xray health result", auto)

    def test_android_bridge_rewrites_only_selected_endpoint_dial_address(self) -> None:
        base = {
            "inbounds": [{"tag": "socks-in", "port": 1080, "protocol": "socks", "settings": {"auth": "noauth"}}],
            "outbounds": [
                {
                    "tag": "smart-de-relay-mobile",
                    "protocol": "vless",
                    "settings": {"vnext": [{"address": "185.240.120.152", "port": 443, "users": []}]},
                    "streamSettings": {"network": "tcp", "realitySettings": {"serverName": "smart-de-mobile.example"}},
                },
                {"tag": "direct", "protocol": "freedom"},
            ],
        }
        config, remote_host, remote_port = cellular_bridge_endpoint_config(base, "smart-de-relay-mobile", 11080, 12080)
        selected = next(outbound for outbound in config["outbounds"] if outbound["tag"] == "smart-de-relay-mobile")
        direct = next(outbound for outbound in config["outbounds"] if outbound["tag"] == "direct")
        self.assertEqual((remote_host, remote_port), ("185.240.120.152", 443))
        self.assertEqual(selected["settings"]["vnext"][0]["address"], "127.0.0.1")
        self.assertEqual(selected["settings"]["vnext"][0]["port"], 12080)
        self.assertEqual(selected["streamSettings"]["realitySettings"]["serverName"], "smart-de-mobile.example")
        self.assertNotIn("settings", direct)

    def test_android_cellular_interface_requires_connected_validated_network(self) -> None:
        cellular = (
            "NetworkAgentInfo{network{137} ni{MOBILE[LTE] CONNECTED extra: internet} "
            "lp{{InterfaceName: rmnet4 LinkAddresses: [10.70.202.51/24]}} "
            "nc{[ Transports: CELLULAR Capabilities: INTERNET&VALIDATED&NOT_VPN ]}}"
        )
        unvalidated = cellular.replace("&VALIDATED", "")
        self.assertEqual(validated_cellular_interface(cellular), "rmnet4")
        with self.assertRaisesRegex(RuntimeError, "no connected, validated cellular network"):
            validated_cellular_interface(unvalidated)

    def test_android_keeper_holds_partial_wake_lock_only_while_usb_powered(self) -> None:
        manifest = (REPO_ROOT / "android-test-agent" / "AndroidManifest.xml").read_text(encoding="utf-8")
        keeper = (
            REPO_ROOT
            / "android-test-agent"
            / "src"
            / "com"
            / "bezrabotnyi"
            / "vpntestagent"
            / "BenchmarkDeviceService.java"
        ).read_text(encoding="utf-8")
        self.assertIn("android.permission.WAKE_LOCK", manifest)
        self.assertIn("android.permission.RECEIVE_BOOT_COMPLETED", manifest)
        self.assertIn(".BenchmarkDeviceReceiver", manifest)
        self.assertIn("PowerManager.PARTIAL_WAKE_LOCK", keeper)
        self.assertIn("BatteryManager.BATTERY_PLUGGED_USB", keeper)
        self.assertIn("WifiManager.WIFI_MODE_FULL_HIGH_PERF", keeper)
        self.assertIn("START_STICKY", keeper)

    def test_android_adb_reconnect_promotes_mdns_port_to_fixed_port(self) -> None:
        reconnect = (REPO_ROOT / "scripts" / "android-adb-reconnect.sh").read_text(encoding="utf-8")
        self.assertIn("_adb-tls-connect._tcp", reconnect)
        self.assertIn("ro.serialno", reconnect)
        self.assertIn('FIXED_PORT="${ANDROID_ADB_FIXED_PORT:-5555}"', reconnect)
        self.assertIn('tcpip "$FIXED_PORT"', reconnect)
        self.assertIn('"$device_ip:$FIXED_PORT"', reconnect)
        self.assertIn("cmd wifi set-connected-score 0", reconnect)
        self.assertIn("svc wifi enable", reconnect)
        self.assertIn("cmd wifi start-scan", reconnect)
        self.assertIn("settings put global network_avoid_bad_wifi 0", reconnect)
        self.assertIn("wifi_ipv4()", reconnect)
        self.assertIn('[[ -n "$device_ip" ]] && break', reconnect)
        self.assertIn('ADB_COMMAND_TIMEOUT="${ANDROID_ADB_COMMAND_TIMEOUT:-3}"', reconnect)
        self.assertIn('timeout --foreground "$ADB_COMMAND_TIMEOUT"', reconnect)
        self.assertIn("recovery_attempts=5", reconnect)
        self.assertIn('[[ "$PROMOTE_FIXED_PORT" == "1" ]]', reconnect)

    def test_android_benchmark_setup_preserves_wifi_control_and_forces_mobile_wan(self) -> None:
        setup = (REPO_ROOT / "scripts" / "configure-android-benchmark-device.sh").read_text(encoding="utf-8")
        self.assertIn("adb_allowed_connection_time 0", setup)
        self.assertIn("mobile_data_always_on 1", setup)
        self.assertIn("network_avoid_bad_wifi 1", setup)
        self.assertIn("wifi_sleep_policy 2", setup)
        self.assertIn("stay_on_while_plugged_in 0", setup)
        self.assertIn("screen_off_timeout 300000", setup)
        self.assertNotIn("screen_off_timeout 15000", setup)
        self.assertIn("dhcp.samsung_vpn_test", setup)
        self.assertIn("firewall.samsung_vpn_test_block_wan", setup)
        self.assertIn("firewall.samsung_vpn_test_block_wanb", setup)
        self.assertIn('src_ip="$device_ip"', setup)

    def test_server100_uses_usb_adb_without_fixed_port_promotion(self) -> None:
        server100 = (REPO_ROOT / "deploy" / "server-100" / "systemd" / "android-adb-reconnect.service").read_text(encoding="utf-8")
        server44 = (REPO_ROOT / "deploy" / "server-44" / "systemd" / "android-adb-reconnect.service").read_text(encoding="utf-8")
        reconnect = (REPO_ROOT / "scripts" / "android-adb-reconnect.sh").read_text(encoding="utf-8")
        self.assertIn("android-adb-usb-watchdog", server100)
        self.assertIn("ANDROID_USB_VENDOR_PRODUCT_REGEX", server100)
        self.assertNotIn("ANDROID_ADB_PROMOTE_FIXED_PORT", server100)
        self.assertIn("ANDROID_ADB_PROMOTE_FIXED_PORT=1", server44)
        self.assertIn("TimeoutStartSec=45", server100)
        self.assertIn("TimeoutStartSec=45", server44)
        self.assertIn('PROMOTE_FIXED_PORT="${ANDROID_ADB_PROMOTE_FIXED_PORT:-1}"', reconnect)
        self.assertIn('disconnect "$fixed_endpoint"', reconnect)

    def test_concurrent_runs_reserve_distinct_socks_ports(self) -> None:
        first = PortReservations.create(3)
        second = PortReservations.create(3)
        try:
            self.assertEqual(len(set(first.ports)), 3)
            self.assertTrue(set(first.ports).isdisjoint(second.ports))
        finally:
            first.close()
            second.close()

    def test_telemetry_sink_posts_incremental_events_immediately(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            sink = TelemetrySink("run-1", "health", {"id": "lan-server44", "networkClass": "lan", "client": "xray", "accessMethod": "socks-proxy", "wireMethod": "wire-internal", "hostRole": "server-44"}, Path(temp_dir))
            with mock.patch.object(sink, "_post", return_value=True) as post:
                event = sink.emit("stage_started", endpoint="smart-de-relay", stage="preflight")

            post.assert_called_once()
            payload = json.loads(post.call_args.args[0])
            self.assertEqual(payload["eventId"], event["eventId"])
            self.assertEqual(payload["type"], "stage_started")
            self.assertEqual(payload["sequence"], 1)


if __name__ == "__main__":
    unittest.main()
