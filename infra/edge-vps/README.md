# Edge VPS small-host profile

This directory captures the runtime tuning applied to the tiny smart-edge VPS nodes
`vpn2` and `vusa` on 2026-06-28.

Target shape:

- 1 vCPU
- about 1 GB RAM
- 9–10 GB disk
- Ubuntu/Debian with systemd
- services: nginx, Xray, smart-edge, GPTAdmin shell/rootd, optional whitetransport/go experiments

The goal is not generic Linux tuning. It is a practical profile for many inbound
and outbound Internet connections while keeping logs/cache small and avoiding OOM.

## Apply

Copy the repo or this directory to the VPS, then run:

```bash
sudo infra/edge-vps/edge-small-vps-apply.sh --swap-size 1G
```

On a node that already has enough swap, the script will not create another swap.
To avoid creating swap at all:

```bash
sudo infra/edge-vps/edge-small-vps-apply.sh --no-swap
```

## Check

```bash
sudo infra/edge-vps/edge-small-vps-check.sh
```

The check prints sysctl values, service limits, log usage, memory/swap, important
listeners, `nginx -t`, and `xray -test`.

## What the apply script configures

Network/kernel:

- `somaxconn=65535`
- `netdev_max_backlog=16384`
- `tcp_max_syn_backlog=65535`
- ephemeral ports `10000..65535`
- `tcp_fin_timeout=15`
- TCP keepalive `600/30/5`
- `tcp_fastopen=3`
- BBR if available, otherwise current congestion control
- qdisc `fq` if already available on the default interface, otherwise `fq_codel`
- conservative socket buffers for 1 GB RAM hosts

Memory/disk:

- `swappiness=10`
- `vfs_cache_pressure=150`
- dirty ratios `5/10`
- optional `/swapfile` when no swap exists

Limits:

- `LimitNOFILE=1048576`
- `TasksMax=infinity`
- drop-ins for nginx, xray, smart-edge, gptadmin-shellmcp, gptadmin-rootd

Logs/cleanup:

- journald capped to 64 MB persistent, 32 MB runtime, 7 days
- nginx logs: daily, rotate 3, max 20 MB, compressed
- btmp/wtmp capped
- daily `edge-cleanup.timer` vacuums journal, cleans apt cache/lists, old tmp files,
  and old rotated logs

Service slimming:

The apply script disables nonessential background services if present:

- snapd / snapd.socket
- packagekit
- ModemManager
- multipathd
- apport
- unattended-upgrades

Re-enable any of them with:

```bash
sudo systemctl enable --now <service>
```

## Results observed on 2026-06-28

`vpn2`:

- `/var/log`: about 1.2 GB → 30 MB
- disk used: 6.2 GB → 5.0 GB
- swap: `/swapfile` 1 GB, low-swappiness OOM safety
- smart-edge check: `api.ipify.org` returned `212.192.31.128`

`vusa`:

- `/var/log`: about 1.1 GB → 79 MB
- disk used: 7.0 GB → 5.6 GB
- apt lists: 301 MB → 4 KB
- smart-edge check: `api.ipify.org` returned `185.240.120.152`

## OS note

Ubuntu is not the lightest choice, but after disabling snapd/packagekit/multipathd
and capping logs it is acceptable for this stack. If reinstalling from scratch,
Debian 12 minimal is the preferred lighter baseline. Alpine is not recommended
for this particular stack because systemd drop-ins, journald, GPTAdmin, certbot,
nginx and Xray workflows are simpler on Debian/Ubuntu.
