# Mac recovery, performance, Codex, and VPN

Status: active

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
