import { readFile } from "node:fs/promises";
import path from "node:path";

import { renderLanSmartEdgeConfig, renderLanSmartEdgeWithTelegramTproxy, type XrayObject } from "../lan-smart-edge.js";
import { loadTelegramTransparentLaneConfig } from "../telegram-transparent-lane.js";

const sourcePath = process.env.LAN_SMART_EDGE_SOURCE_CONFIG
  || path.join(process.cwd(), "deploy/server-88/xray/config.json");
const listenAddress = process.env.LAN_SMART_EDGE_LISTEN_IP || "192.168.2.5";
const enableTelegramTproxy = process.env.LAN_SMART_EDGE_TPROXY === "1";

const base = JSON.parse(await readFile(sourcePath, "utf8")) as XrayObject;
const rendered = enableTelegramTproxy
  ? renderLanSmartEdgeWithTelegramTproxy(base, listenAddress, await loadTelegramTransparentLaneConfig())
  : renderLanSmartEdgeConfig(base, listenAddress);
process.stdout.write(`${JSON.stringify(rendered, null, 2)}\n`);
