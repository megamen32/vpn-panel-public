# Telegram and CloudFront route canary auto-heal

Started at 2026-08-27T03:39:51+03:00 (manual clock)

- Wanted result: a regression check detects a broken Telegram DC route or a CloudFront dependency route and restores the affected canonical LAN policy automatically.
- Shortest real canary: router DNS resolves the CloudFront hostname to the LAN edge and a real Mac reaches Telegram DC IPs without a system proxy.
- Smallest YAGNI vertical slice: one bounded router-side watchdog test and repair command for the existing generated SmartDNS policy; retain the existing Telegram procd watchdog instead of creating a second Telegram controller.
- Discard: generic LLM-driven remediation, changes to GitHub SSH records, a new monitoring dashboard, and unrelated endpoint-health work.

Cycle: trace existing canaries and Fast Agent boundary, then add only the missing durable watchdog behavior. Estimate: minimum 12, maximum 35 active minutes. Active time: not continuously measured.
Evidence: Mac canary reached all four Telegram DCs on TCP/443 and fetched the
CloudFront asset through the router with HTTP 200. Existing Telegram procd
watchdogs are live. Fast Agent is installed but has no configured model,
AgentCard, or scheduler, so it cannot honestly be made the repair controller.

Delivery: added `smart-dns-route` as a procd-supervised router watchdog. It
checks the actual CloudFront hostname every 30 seconds and, after two failures,
reapplies the persisted canonical SmartDNS policy with a timestamped backup.
The repair initially exposed a same-file copy bug, which was fixed and covered
by regression tests.

Verification: focused CloudFront + Telegram suites pass 15/15. The router
completed a real `--repair`, the route watchdog restarted from PID 12012 to
13905 under procd, and both Telegram watchdogs remain active. A Mac canary
after deployment returned CloudFront HTTP 200 and Telegram DC TCP 4/4.

Fast Agent boundary: `fast-agent check` shows no model, AgentCard, or scheduler
configured. It was therefore not represented as a live repair controller.

Status: complete.
