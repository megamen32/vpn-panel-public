## 2026-08-07 — SmartDNS SponsorBlock (Short)

- What slowed or confused L? Existing shared policy file was dirty from unrelated `hailuo.ai` work; it required careful preservation.
- Which instruction should change? none
- Which skill, MCP, or tool is missing? none
- What operation or error repeated? none; one focused RED run was expected and served as the regression gate.
- State: fixed now

## 2026-08-08 — Local SmartDNS normal VPN default (Full)

- What slowed or confused L? The initial GeoIP/VUSA interpretation was corrected by the user; the actual delta is the LAN default route and deploy generator override.
- Which instruction should change? none
- Which skill, MCP, or tool is missing? none
- What operation or error repeated? Full suite needed one stale Cloudflare assertion update after changing the default; final result 348/348.
- State: fixed now

## 2026-08-08 — Local SmartDNS US-only correction (Full)

- What slowed or confused L? The user explicitly required LAN default `direct`; the broad-default implementation was a scope error and was reverted before deploy.
- Which instruction should change? none
- Which skill, MCP, or tool is missing? none
- What operation or error repeated? none; focused tests and build passed after the reversal.
- State: fixed now

## 2026-08-08 — SmartDNS Notion (Short)

- What slowed or confused L? “PDMN” was not independently documented; the requested host is safely covered by the parent `notion.so` suffix.
- Which instruction should change? none
- Which skill, MCP, or tool is missing? none
- What operation or error repeated? none; focused RED/GREEN and build were sufficient.
- State: fixed now

## 2026-09-29 — S21 and remote-bundle recovery (Short)

- What slowed or confused L? `agent-device devices` first showed a stale workspace owner, but after `close` it hid the claim while `open` still returned `DEVICE_IN_USE`; only `daemon stop` exposed and released the remaining `default` claim.
- Which instruction should change? `ServersAdministartion/AGENTS.md`: add the bounded recovery order `device status --stale` -> verify no recent sessions -> `daemon stop` -> reopen, under the S21 lease.
- Which skill, MCP, or tool is missing? Proposed: `agent-device device reconcile --serial ...` that reports daemon-registry and host-lock ownership together and releases only a provably stale union.
- What operation or error repeated? `open` returned `DEVICE_IN_USE` three times despite `--force`/`close`; guard by checking both workspace and daemon-global session aliases before retrying.
- State: Proposed

## 2026-09-29 — M1 Tailscale and ZCode recovery (Short)

- What slowed or confused L? The prior proven recipe `accept-dns=false -> 192.168.2.1` had drifted: today the LAN resolver hung while Tailscale DNS was healthy, so applying memory briefly worsened the canary and had to be reverted.
- Which instruction should change? `ServersAdministartion/AGENTS.md`: before reusing a remembered DNS fix, require current system/explicit resolver matrix plus one Node-fetch canary through the active exit node.
- Which skill, MCP, or tool is missing? Proposed: a read-only Mac Tailscale transition probe that records pre/post resolver order, exit node, Node fetch, and ZCode log errors in one bounded run.
- What operation or error repeated? `UND_ERR_CONNECT_TIMEOUT` appeared four times after switching to the currently unhealthy LAN DNS; guard by reverting on the first failed post-change customer canary.
- State: fixed now

## 2026-09-29 — Server-100 ZCode mobile remote (Short)

- What slowed or confused L? A base `/remote/v4` HTTP 200 and GUI `Ready` were false positives; fresh 3.12.1 signed URLs still returned 404 until the desktop package was updated.
- Which instruction should change? Add to real-surface acceptance: test the exact locally generated signed URL without printing it, then require a rendered browser workspace and desktop-side `Phone connected` state.
- Which skill, MCP, or tool is missing? Proposed: a secret-safe browser canary that reads a local clipboard URL, navigates through CDP without argv/log exposure, and reports only status/title/visual state.
- What operation or error repeated? `agent-device snapshot` timed out twice and signed-link 404 reproduced twice; guard with one screenshot fallback plus exact credential-safe E2E before declaring success.
- State: fixed now
