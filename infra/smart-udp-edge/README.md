# Smart UDP Edge: UDP/443 QUIC relay

Flow:

1. Smart DNS fake-routes a proxied A query to edge IPs.
2. Smart DNS records `client_ip -> domain` for the edge auth TTL, currently one day.
3. `smart-udp-edge` listens on UDP/443 on `vpn2` and `vusa`.
4. On first packet from a client, it calls `/edge-map?ip=<client_ip>` with the shared edge token.
5. It relays UDP between the client and `<domain>:443`.

This is deliberately narrow: UDP/443 only, intended for QUIC/HTTP3. It is not a
generic transparent UDP proxy.

Runtime paths:

```text
/opt/smart-udp-edge/udp443-relay.py
/etc/smart-udp-edge/config.json
/etc/systemd/system/smart-udp-edge.service
```

Check:

```bash
sudo systemctl status smart-udp-edge --no-pager
sudo ss -ulnp | grep ':443'
sudo journalctl -u smart-udp-edge -n 50 --no-pager
```
