import assert from "node:assert/strict";
import test from "node:test";

import { withVusaSmartEdgeLanes } from "../src/lan-us-config.js";
import { renderOpenWrtAddressRules } from "../src/openwrt-smart-dns.js";
import { checkSmartDnsRoute, DEFAULT_SMART_DNS_POLICY } from "../src/smart-dns-policy.js";

test("Cloudflare challenge subdomains stay outside the LAN VUSA exception", () => {
  for (const hostname of ["brunhild.challenges.cloudflare.com", "future-token.challenges.cloudflare.com"]) {
    const route = checkSmartDnsRoute(hostname, DEFAULT_SMART_DNS_POLICY);
    assert.equal(route.localRoute, "direct");
    assert.notEqual(route.publicEdgeProfile, "vusa");
    assert.notEqual(route.matched, "challenges.cloudflare.com");
  }
  assert.doesNotMatch(renderOpenWrtAddressRules(DEFAULT_SMART_DNS_POLICY), /^challenges\.cloudflare\.com$/m);

  const config = {
    outbounds: [],
    routing: {
      balancers: [
        { tag: "proxy", selector: ["de-cdn"] },
        { tag: "us-auto", selector: ["to-us-reality"] },
      ],
      rules: [
        {
          type: "field",
          inboundTag: ["in-lan-smart-http", "in-lan-smart-tls"],
          domain: [
            "domain:antigravity.google",
            "domain:gweb-jetski.appspot.com",
            "domain:challenges.cloudflare.com",
          ],
          balancerTag: "us-auto",
        },
        { type: "field", inboundTag: ["in-lan-smart-http", "in-lan-smart-tls"], balancerTag: "proxy" },
      ],
    },
    observatory: { subjectSelector: [] },
  };

  const generated = withVusaSmartEdgeLanes(config);
  assert.deepEqual(generated.routing.rules[0], {
    type: "field",
    inboundTag: ["in-lan-smart-http", "in-lan-smart-tls"],
    domain: [
      "domain:antigravity.google",
      "domain:gweb-jetski.appspot.com",
    ],
    balancerTag: "us-auto",
  });
  assert.equal(generated.routing.rules[1]?.balancerTag, "proxy");
  assert.ok(!generated.routing.rules.some((rule) => rule.domain?.includes("domain:challenges.cloudflare.com")));
});


test("Cloudflare stays direct for VPN routing while DNS policy remains unchanged", () => {
  for (const hostname of ["www.cloudflare.com", "challenges.cloudflare.com", "a.nel.cloudflare.com"]) {
    const route = checkSmartDnsRoute(hostname, DEFAULT_SMART_DNS_POLICY);
    assert.equal(route.vpnRoute, "direct", hostname);
    assert.equal(route.localRoute, "direct", hostname);
    assert.equal(route.publicRoute, "proxy", hostname);
  }
});


test("Cloudflare DoH keeps its existing VPN route", () => {
  const route = checkSmartDnsRoute("cloudflare-dns.com", DEFAULT_SMART_DNS_POLICY);
  assert.notEqual(route.vpnRoute, "direct");
  assert.equal(route.publicRoute, "proxy");
});
