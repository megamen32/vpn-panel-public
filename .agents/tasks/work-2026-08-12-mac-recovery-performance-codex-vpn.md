# Mac recovery, performance, Codex, and VPN

Status: complete

Lifecycle state: work

## Original request

> а сейчас тунель нет? подключись и 1- почини codex удали opencodex а то мешает яне могу кодекс модели вызвать. или что мешает? 2- ускорь производетность выключи всякие лишние анимации и движущие обои и тп все что зря память занимает игрузит систему-главное производельность. 3- настрой впн чтобы нормально работал

## Objective

Restore managed access to the M1 Mac, remove the concrete OpenCode conflict only if it is present, make reversible performance-focused macOS adjustments, and leave Bez VPN working with the system SOCKS proxy disabled.

## Business canary

The M1 accepts SSH through `user@localhost:2222`; Codex can list and invoke its configured models without OpenCode interference; unnecessary visual/background load is reduced without disabling the active network; and `bez smart --global` leaves macOS SOCKS disabled while `t.me` works through the explicit local SOCKS proxy.

## Confirmed scope

- Diagnose and restore the existing reverse SSH tunnel.
- Inspect and remove OpenCode only from the M1 Mac if it conflicts with Codex.
- Apply reversible user-level macOS performance settings after baseline measurement.
- Update the M1 Bez CLI from the published installer and prove system proxy/SOCKS behavior.

## Explicit exclusions

- No deletion of user documents, projects, credentials, Codex sessions, or VPN profiles.
- No firewall, router, DNS, upstream VPN, or panel-routing changes unless live Mac evidence shows they are necessary.
- No unrelated repository changes.

## Initial estimate

- Minimum / maximum active minutes: 25 / 55

## Started at

2026-08-12 09:27 MSK

## Lifecycle provenance

Created from the user's direct Mac recovery and optimization request.

## Last task-file mtime observed

2026-08-12 09:27 MSK

## Runtime identity

- Harness: Codex desktop
- PID: unknown
- Agent session: current
- PID status: running
- Last PID signal: initial task creation
- Last task-file transition: todo created

## Plan

1. Read-only trace the missing reverse SSH tunnel and identify a reachable Mac control path.
2. Inventory Codex/OpenCode, VPN, login items, resource pressure, and visual settings on the Mac.
3. Apply only the evidenced removals/settings and verify each intended user outcome.

## Evidence log

- 2026-08-12 09:27-09:31 MSK: `127.0.0.1:2222` refuses connections and has no listener. The old M1 LAN address `192.168.2.8` has a failed ARP entry on both server-100 and OpenWrt, no DHCP lease, and no mDNS response. The Mac is unavailable outside the server tunnel as well.
- 2026-08-12 09:31 MSK: `mac100-bridge-watchdog.timer` is active but last triggered 2026-08-07; its persisted failure streak is 2. Its script only probes `127.0.0.1:2222`; it cannot establish a reverse tunnel itself. Server-side SSH is active. No host/service mutation performed.
- 2026-08-12 09:32 MSK: User must wake/connect the physical Mac before its Codex/OpenCode installation, visual workload, or VPN settings can be safely inspected or changed.
- 2026-08-12 09:37 MSK: Tunnel returned and passed a real SSH command. The reverse `autossh -R 127.0.0.1:2222:localhost:22` was a child of interactive `ttys000`, not launchd; it is therefore lost with that terminal/session.
- 2026-08-12 09:40 MSK: Existing `com.roomhacker.mac100.reverse-local.plist` and watchdog plist are malformed arrays, not launchd dictionaries. Their scripts and `local.conf` are otherwise suitable and use remote port 2222. Temporary plist payloads were staged but never applied because the interactive tunnel died during transfer; no Mac launchd file was replaced.
- 2026-08-12 09:44 MSK: On server-100, the watchdog timer had no next trigger due to `OnUnitActiveSec` combined with the oneshot inactive state. Backed up `/etc/systemd/system/mac100-bridge-watchdog.timer` and changed it to `OnUnitInactiveSec=30s`; `systemctl list-timers` now shows a next run in 30 seconds. This only monitors the Mac-originated tunnel; it cannot originate it.
- 2026-08-12 13:33 MSK: Replaced malformed Mac local reverse-tunnel plist with a valid user LaunchAgent. `com.roomhacker.mac100.reverse-local` is `running`, PID 35617, parented by launchd, with `RunAtLoad` and `KeepAlive`. Added and validated the minute watchdog LaunchAgent. Server watchdog last result is success, failure streak 0, and next check is scheduled.
- 2026-08-12 14:16-14:22 MSK: Removed `com.opencodex.proxy`, user data `~/.opencodex`, global `@bitkyc08/opencodex` package, and its `/opt/homebrew/bin/opencodex` shim. Codex is logged into ChatGPT. Real requests completed with explicit `gpt-5.4` (`READY`) and configured default `gpt-5.6-luna` (`DEFAULT_READY`).
- 2026-08-12 14:17 MSK: Updated `bez` from the public installer. Smart proxy canary `t.me` returned 302. Full proxy canary returned expected DE exit IP `212.192.31.128` and `t.me` 302. Final Smart Global has HTTP/HTTPS at `127.0.0.1:11809` and system SOCKS disabled.
- 2026-08-12 14:18-14:22 MSK: Existing macOS performance visual settings already had reduce motion/transparency enabled, Dock launch animation disabled, Expose duration 0.05, Finder animations disabled, and automatic window animations disabled. Dynamic `Sequoia Sunrise.mov` wallpaper remains because user-level AppleEvent APIs did not change it remotely; no TCC bypass or system-file mutation attempted.
- 2026-08-12 14:31 MSK: RAM attribution: no swapins/out, no swapouts, 75% CPU idle, so the machine was not under memory pressure. Largest resident processes were Codex renderer 1.33 GiB, ClipBook + renderer 1.15 GiB, and Chrome. ClipBook was an automatic Login Item and not needed for the requested result, so it was quit and removed from Login Items; memory free percentage rose from 78% to 81%.
- 2026-08-12 14:33-14:38 MSK: VPN discovered a real readiness race: immediately after `bez` mode changes, its ports could be listening while early SOCKS requests failed. Stable Smart SOCKS passed 5/5 (`t.me` 302, YouTube 200). Full later passed 3/3 with expected DE exit IP `212.192.31.128`. Added `wait_traffic` to the generated Bez installer: it gates success on `t.me`, and in Full also on an HTTP proxy exit-IP request. Built, restarted `autovpnallowip.service`, updated the M1 installer, and proved Full waits 8s then returns exit IP `212.192.31.128` plus `t.me` 302; final Smart returned `t.me` 302 with HTTP/HTTPS at 11809 and system SOCKS disabled.
