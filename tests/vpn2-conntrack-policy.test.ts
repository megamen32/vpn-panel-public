import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("vpn2 conntrack policy is canonical and previewable without a remote mutation", async () => {
  const [script, sysctl, modprobe] = await Promise.all([
    readFile(new URL("../scripts/deploy-vpn2-conntrack.sh", import.meta.url), "utf8"),
    readFile(new URL("../deploy/vpn2/sysctl/99-vpn2-nf-tune.conf", import.meta.url), "utf8"),
    readFile(new URL("../deploy/vpn2/modprobe.d/nf_conntrack-hashsize.conf", import.meta.url), "utf8"),
  ]);

  assert.match(sysctl, /^net\.netfilter\.nf_conntrack_max = 65536$/m);
  assert.match(sysctl, /^net\.netfilter\.nf_conntrack_tcp_timeout_established = 86400$/m);
  assert.match(sysctl, /^net\.netfilter\.nf_conntrack_tcp_timeout_time_wait = 15$/m);
  assert.match(modprobe, /^options nf_conntrack hashsize=16384$/m);
  assert.match(script, /VPN2_CONNTRACK_LIVE_APPROVED/);
  assert.match(script, /bak_conntrack_/);
  assert.match(script, /sysctl -p/);
  assert.match(script, /nf_conntrack\/parameters\/hashsize/);

  const preview = spawnSync("bash", [new URL("../scripts/deploy-vpn2-conntrack.sh", import.meta.url).pathname, "preview"], { encoding: "utf8" });
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /valid; no remote change/);
});
