# VPN transport verification — 2026-09-16

Hysteria2 on Germany, USA and Finland is available through existing subscriptions. The existing TCP routes remain available as fallbacks; this is a measured improvement for these networks, not a claim of universal speed or availability.

## Deployment and distribution

- Managed fleet source: `deploy/vpn-fleet.json`; Finland is also registered in secure `vps_list`. Transport credentials remain outside Git.
- Each host runs isolated `vpn-hysteria2.service` on UDP24443, with verified TLS and the existing enabled clients' UUID authentication. Private/LAN destinations are blocked without requiring an external geo database.
- Controller `vpn-hysteria2-sync.timer` synchronizes enabled users every five minutes. New and revoked credentials may take up to that interval to propagate. Last observed successful execution: 2026-09-16 18:12:41 MSK.
- All 11 active clients passed live HTTP subscription checks: Happ Auto first, Finland included, and Hysteria2 URI entries in the plain subscription. Evidence: `vpn-testing/results/subscription-distribution-20260916.json`.
- The panel's Happ import action now selects `happ-json`. Previously imported plain subscriptions must be reimported using that action to receive Auto. Plain URIs remain available for other clients; equivalent Auto behavior in Streisand/v2rayNG is not claimed.
- Scheduled health measurements cover the new transports and render a fresh catalog into `vpn-testing/results/health-plan.json`, preserving the shared source test plan.
- The final scheduled runner completed successfully at 18:22:37 MSK: 15/15 routes eligible, including all three Hysteria2 routes and Germany XHTTP H2. Artifact: `unified-lan-server44-health-20260916_182119.json`. This LAN result does not replace the separate Android cellular failures.

## Comparable measurements

Mac M1 measurements were sequential, with the native Happ tunnel disconnected to avoid nesting VPNs. Throughput is a short download result, not a bandwidth guarantee. HTTPS is request completion time, not ICMP RTT.

| Route | Mac Mbps | Mac Telegram HTTPS ms | Android Wi-Fi Mbps | Android cellular Mbps |
|---|---:|---:|---:|---:|
| Finland Hysteria2 | 49.45 | 322 | 41.53 | 5.22 |
| Germany Hysteria2 | 36.59 | 427 | 37.25 | 22.11 |
| USA Hysteria2 | 18.82 | 1602 | 11.82 | 2.40 |
| Germany XHTTP H2 | 33.18 | 494 | 27.23 | 4.09 |
| Existing Finland relay | 29.45 | 548 | not measured in this slice | not measured in this slice |

Android SM-G998B was accessed over USB from Windows `192.168.2.190`; outbound sockets were explicitly bound to Wi-Fi `wlan0` or cellular `rmnet4`. Both Finland and Germany Hysteria2 had a reset on the first cellular request; the next two requests and each complete 3 MB download succeeded. The importer preserves both as ineligible runs; it does not promote a route from speed alone. USA Hysteria2 and Germany XHTTP H2 had three successful cellular requests and complete downloads. All four routes passed all final Wi-Fi checks. An earlier German cellular cold start also failed and is retained in the raw initial artifact.

Historical reliability and latency are displayed in Happ; telemetry contains the real Mac and Android artifacts. One successful new Mac run is a small sample, not proof of long-term 100% reliability.

Artifacts under the controller's permanent `vpn-testing/results/`:

- `mac-transport-comparison-20260916.json`: 11 routes, 10 eligible; Germany direct Reality failed.
- `mac-finland-hy2.json`: direct Finnish Hysteria2 benchmark.
- `android-hy2-verified-20260916.log` and `-wlan0.json` / `-rmnet4.json`: final Android run. `android-hy2-final-20260916.log` was a predeployment probe and must not be treated as a steady-state Finnish failure.
- `auto-failover-result.json`: controlled failover evidence.
- `hy2-quality-current-20260916.json`: telemetry snapshot.

## Recovery and native client evidence

- Controlled stop of the unpublished German Hysteria2 service: the real Xray Auto config resumed new connections through the existing Finnish relay after 23.38 seconds. Existing TCP sessions are not seamlessly migrated.
- VUSA isolated Hysteria2 process SIGKILL: systemd returned active/running within the four-second check, `NRestarts=1`. This proves process crash recovery, not recovery from every possible hung process or network outage.
- After publishing, native Happ 5.3.0 on Mac M1 refreshed the real subscription and started Xray 26.7.11 successfully at 15:12:54 UTC. Auto remained selected and connected. Happ's own current-connection check returned 104 ms. Native HTTPS requests: Telegram API 302/233 ms, YouTube 200/383 ms, ChatGPT 403/361 ms. The ChatGPT status proves HTTPS reachability only, not an authenticated chat session. Smart routing sends some destinations directly; a generic Cloudflare trace is not sufficient evidence of VPN egress.
- iPhone Mirroring remains blocked on unlocking Nikita's iPhone. Client-compatible subscriptions are published, but physical iPhone import and traffic are not verified.
- After the final health-runner change, the still-connected native Auto passed Telegram API HTTPS 302 and YouTube HTTPS 200 again. No VPN service or native client restart followed this canary.

## Validation and operational limits

Focused subscription/Hysteria tests and Xray configuration validation passed. The initial full suite had 443/447 passes; the changed Happ deep-link assertion was then fixed and passed. Three HAOS-related failures remain outside this transport slice; no clean-baseline claim is made. Both primary checkouts contain preserved unrelated work; scoped commits were published from the existing clean delivery clones.
