import { readdir, stat } from "node:fs/promises";

import type { RoutingRule } from "./routing-rules.js";

export interface GeoAssetInfo {
  kind: "geoip" | "geosite";
  file: string;
  path: string;
  exists: boolean;
  bytes: number;
  size: string;
  tags: string[];
  usedTags: string[];
}

export interface GeoCatalog {
  directory: string;
  assets: GeoAssetInfo[];
  availableFiles: string[];
  generatedAt: string;
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
};

export async function inspectGeoCatalog(rules: readonly RoutingRule[], directory = process.env.VPN_PANEL_XRAY_GEO_DIR || "/etc/vpn-panel/xray-geo"): Promise<GeoCatalog> {
  const used = { geoip: new Set<string>(), geosite: new Set<string>() };
  for (const rule of rules) {
    const match = /^(geoip|geosite):([a-z0-9_.-]+)$/i.exec(rule.text);
    if (match) used[match[1] as "geoip" | "geosite"].add(match[2].toLowerCase());
  }
  // These selectors are compiled into the generated client profiles even when
  // the admin table has no explicit row for them.
  used.geoip.add("private");
  used.geoip.add("ru");
  used.geosite.add("ru-inside");
  const files = await readdir(directory).catch(() => [] as string[]);
  const assets: GeoAssetInfo[] = (["geoip", "geosite"] as const).map((kind) => {
    const file = `${kind}.dat`;
    return { kind, file, path: `${directory}/${file}`, exists: false, bytes: 0, size: "не найден", tags: [...used[kind]].sort(), usedTags: [...used[kind]].sort() };
  });
  await Promise.all(assets.map(async (asset) => {
    try {
      const info = await stat(asset.path);
      asset.exists = info.isFile();
      asset.bytes = asset.exists ? info.size : 0;
      asset.size = asset.exists ? formatBytes(info.size) : "не найден";
    } catch { /* absent asset is reported explicitly */ }
  }));
  return { directory, assets, availableFiles: files.sort(), generatedAt: new Date().toISOString() };
}
