import { z } from "zod";

/** The runtime client or daemon that owns the tested connection. */
export const vpnTestClientSchema = z.enum(["xray", "sing-box", "smartdns"]);

/** The local access protocol used by the benchmark. */
export const vpnTestAccessMethodSchema = z.enum(["http-proxy", "socks-proxy", "smart-http", "dns"]);

/** The physical/network path used to reach the client under test. */
export const vpnTestWireMethodSchema = z.enum(["4g", "wire-internal", "wire-external", "unknown"]);

/** The concrete machine or device role running the client. */
export const vpnTestHostRoleSchema = z.enum(["server-44", "server-88", "server-100", "mac", "android"]);

export type VpnTestClient = z.infer<typeof vpnTestClientSchema>;
export type VpnTestAccessMethod = z.infer<typeof vpnTestAccessMethodSchema>;
export type VpnTestWireMethod = z.infer<typeof vpnTestWireMethodSchema>;
export type VpnTestHostRole = z.infer<typeof vpnTestHostRoleSchema>;

/** The only execution host considered local for endpoint telemetry. */
export const VPN_TEST_LOCAL_HOST_ADDRESS = "192.168.2.8";

export type VpnTestExecutionLocality = "local" | "non-local";

/** Classify an execution host independently of the traffic network class. */
export function executionLocalityForHostAddress(address: string): VpnTestExecutionLocality {
  return address === VPN_TEST_LOCAL_HOST_ADDRESS ? "local" : "non-local";
}

/** Keep optional host-locality telemetry unambiguous while accepting historical events. */
export function assertVpnTestExecutionLocality(input: {
  executionHostAddress?: unknown;
  executionLocality?: unknown;
}): void {
  const hasAddress = input.executionHostAddress !== undefined;
  const hasLocality = input.executionLocality !== undefined;
  if (!hasAddress && !hasLocality) return;
  if (typeof input.executionHostAddress !== "string" || (input.executionLocality !== "local" && input.executionLocality !== "non-local")) {
    throw new Error("executionHostAddress and executionLocality must be supplied together");
  }
  const expected = executionLocalityForHostAddress(input.executionHostAddress);
  if (input.executionLocality !== expected) {
    throw new Error(`execution locality must be ${expected} for ${input.executionHostAddress}`);
  }
}

/** Convert the explicit wire dimension to the persisted legacy network class. */
export function networkClassForWireMethod(wireMethod: VpnTestWireMethod): "lan" | "external-wired" | "external-mobile" | "external-unknown" {
  if (wireMethod === "4g") return "external-mobile";
  if (wireMethod === "wire-external") return "external-wired";
  if (wireMethod === "unknown") return "external-unknown";
  return "lan";
}

/** Require the dimensions to describe one physically coherent test target. */
export function assertVpnTestTargetDimensions(input: {
  networkClass: string;
  client: VpnTestClient;
  accessMethod: VpnTestAccessMethod;
  wireMethod: VpnTestWireMethod;
}): void {
  const expected = networkClassForWireMethod(input.wireMethod);
  if (input.networkClass !== expected) {
    throw new Error(`wireMethod ${input.wireMethod} requires networkClass ${expected}, got ${input.networkClass}`);
  }
}
