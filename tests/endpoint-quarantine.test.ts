import assert from "node:assert/strict";
import test from "node:test";

import { diagnosticEndpointOrder, subscriptionEndpointOrder } from "../src/secure-config.js";

const quarantinedEndpointIds = [
  "de-direct",
  "us-grpc",
  "us-xhttp-h2-443",
  "us-xhttp",
  "us-direct-ws",
  "us-httpupgrade",
] as const;

test("failed fallbacks stay available for diagnostics but are absent from public subscriptions", () => {
  for (const endpointId of quarantinedEndpointIds) {
    assert.ok(diagnosticEndpointOrder.includes(endpointId), `${endpointId} must remain diagnostic`);
    assert.ok(!subscriptionEndpointOrder.includes(endpointId), `${endpointId} must remain quarantined from subscriptions`);
  }
});
