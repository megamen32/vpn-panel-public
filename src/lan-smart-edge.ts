import net from "node:net";

import { renderTelegramTransparentLaneCandidate, type TelegramTransparentLaneConfig } from "./telegram-transparent-lane.js";

export type XrayObject = Record<string, unknown>;

const LAN_SMART_INBOUND_TAGS = new Set(["in-lan-smart-http", "in-lan-smart-tls"]);

/** Derive the DNS-addressable Xray listeners for a second LAN Smart Edge. */
export function renderLanSmartEdgeConfig(baseConfig: XrayObject, listenAddress: string): XrayObject {
  if (net.isIP(listenAddress) !== 4) {
    throw new Error(`LAN Smart Edge requires an IPv4 listen address, got ${JSON.stringify(listenAddress)}`);
  }
  const baseInbounds = baseConfig.inbounds;
  if (!Array.isArray(baseInbounds)) throw new Error("Xray config must contain an inbounds array");

  const inbounds = baseInbounds
    .filter((inbound): inbound is XrayObject => Boolean(inbound) && typeof inbound === "object" && !Array.isArray(inbound))
    .filter((inbound) => LAN_SMART_INBOUND_TAGS.has(String(inbound.tag)))
    .map((inbound) => ({ ...inbound, listen: listenAddress }));

  if (inbounds.length !== LAN_SMART_INBOUND_TAGS.size) {
    throw new Error("Xray config must contain both in-lan-smart-http and in-lan-smart-tls inbounds");
  }

  return { ...baseConfig, inbounds };
}

/** Add the existing Telegram DC TPROXY candidate to the backup edge only. */
export function renderLanSmartEdgeWithTelegramTproxy(
  baseConfig: XrayObject,
  listenAddress: string,
  telegramConfig: TelegramTransparentLaneConfig,
): XrayObject {
  const edge = renderLanSmartEdgeConfig(baseConfig, listenAddress);
  const candidate = renderTelegramTransparentLaneCandidate(edge, {
    ...telegramConfig,
    tproxy: { ...telegramConfig.tproxy, listenAddress: "0.0.0.0" },
  });
  return candidate;
}
