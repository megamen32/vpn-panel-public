# VUSA nginx ownership

`edge-https.conf` is the product-owned remote VUSA transport vhost. It is
coupled to `deploy/vusa/xray/config.json` and is staged, validated, activated,
and rolled back with that Xray config by `scripts/deploy-all.sh vusa`.

The server-100 nginx controller in `/home/roomhacker/nginx-dev` does not deploy
remote VPS files and must not acquire a duplicate copy. The cross-repository
boundary is recorded in
`/home/roomhacker/ServersAdministartion/infra/vpn-remote-upstreams.md`.
