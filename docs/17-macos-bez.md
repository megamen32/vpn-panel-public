# macOS Bez

`bez` is a rootless Xray client for macOS. It exposes local HTTP and SOCKS5
proxies and can optionally apply them as macOS system proxies. It does not
install a TUN device and does not modify DNS.

## Profiles and scope

The interactive menu displays current status first, then presents three
profiles across two scopes:

| Profile | Local | Global |
| --- | --- | --- |
| Smart | Selected domains use Xray; other traffic stays direct. | Same policy, applied through macOS system proxy. |
| Full | Every proxied external connection uses Xray. | Same policy for apps that respect macOS system proxy settings. |
| Custom | Local domain rules override Smart. | The same Custom rules via macOS system proxy. |

Local means configure the application with the HTTP/SOCKS values printed by
`bez status` or `bez proxy`. Global changes macOS HTTP and HTTPS proxy settings
only for active network services. SOCKS remains local for explicit app settings.
`bez off` restores the saved settings.

## Local dashboard

Run `bez web` and use `http://127.0.0.1:11810/`. The dashboard is served by a
user LaunchAgent and binds only to loopback; it is not reachable from the LAN or
the Internet. It shows whether Xray is running, the current profile and scope,
the local proxy ports, and endpoint selection. Profile controls mirror the same
three-by-two Smart/Full/Custom and Local/Global matrix as the CLI.

Endpoint selection is `Auto (leastPing)` by default. In that mode Xray probes
the candidates listed in the dashboard and chooses the route itself. The
dashboard reads Xray's loopback-only RoutingService and highlights the current
winner for each active balancer. Selecting a concrete endpoint pins every VPN
routing rule directly to that outbound until `Auto (leastPing)` is restored.
It does not change profile routing: Smart/Custom direct rules remain direct,
while Full continues to proxy all external traffic.

The equivalent CLI commands are:

```text
bez endpoint status
bez endpoint list
bez endpoint de-reality
bez endpoint auto
```

Every endpoint change is validated by Xray and a traffic check. A failed manual
selection restores the previous endpoint selection.

The `Проверка endpoint` table starts independent temporary Xray processes, so
testing does not switch or restart the active VPN. For each configured endpoint
it reports HTTPS latency, the observed exit IP, and download throughput. The
throughput probe downloads 1 MB from Cloudflare and stores the latest result in
`endpoint-diagnostics.json` for display after a dashboard restart.

## Automatic healing

The dashboard LaunchAgent also runs a rootless watchdog. Every 20 seconds it
requests `https://t.me/` through the active local HTTP proxy. One or two failures
are reported but do not change routing. After three consecutive failures it
tests the other configured endpoints with independent temporary Xray processes,
selects the working candidate with the lowest measured HTTPS latency, and uses
the normal `bez endpoint` transaction to apply it. That transaction validates
Xray, verifies traffic, and restores the previous selection on failure.

Automatic healing is enabled by default and can be disabled or triggered
immediately next to the endpoint selector. A two-minute cooldown prevents
repeated switch attempts during a wider outage. Settings, current state, and a
bounded event log are stored in `auto-heal.json`, `auto-heal-state.json`, and
`auto-heal.log` under the Bez application directory. The log contains only
timestamps, endpoint tags, latency, and error text; it does not record tokens or
the Xray configuration.

## Local Custom policy

Run `bez custom edit` to create or open:

```text
~/Library/Application Support/BezVPN/custom-policy.json
```

The file is valid JSON with only these keys. A suffix applies to that domain and
all of its subdomains; a domain applies to one hostname only.

```json
{
  "proxySuffixes": ["example.com"],
  "proxyDomains": ["api.example.net"],
  "directSuffixes": ["corp.example"],
  "directDomains": ["status.example.org"]
}
```

Apply it with `bez custom local` or `bez custom global`. Invalid hosts,
wildcards, URLs, and `.local`/`.lan` names are rejected before Xray is restarted.
The Custom file cannot change Xray servers, credentials, or LAN routing.

The same four lists can be edited in the dashboard. `Сохранить` only updates
the local policy; `Сохранить и применить Custom` validates the generated Xray
config and rolls back the file if activation fails. The dashboard also serves a
local PAC file at `http://127.0.0.1:11810/proxy.pac`. Explicit proxy rules and
the Smart domain rules present in the current Xray config use Bez; local,
explicit direct, and unmatched hosts stay direct.

PAC and macOS HTTP/HTTPS system proxy settings affect only applications that
honor proxy configuration. Capturing traffic from every application requires a
TUN/Network Extension or a privileged packet-filter and route setup. Tools such
as tun2socks still create a `utun` interface and change routes; they are not a
rootless replacement for that system boundary.

## Shared Smart policy

`bez custom web` opens `https://vpn.bezrabotnyi.com/admin/smart-dns`. That
administrator page edits the shared SmartDNS policy used for Smart profiles and
shows the predicted route for a domain. It is distinct from the local Custom
file: use the file for one Mac, and the web policy for shared routing rules.

On private offline bundles, a new shared Smart policy arrives with the next
bundle release. Local Custom changes apply immediately on the Mac.

## Verification

Use `bez check` to verify Telegram through the active proxy path. For the Full
profile it also prints the VPN exit IP. If the user LaunchAgent is not running,
the command restores the last requested Local/Global scope instead of
downgrading a Global profile to Local.
