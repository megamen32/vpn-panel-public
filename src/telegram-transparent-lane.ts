import { readFile } from "node:fs/promises";
import path from "node:path";

export interface TelegramTransparentLaneConfig {
  schemaVersion: 1;
  lane: "telegram-transparent";
  status: "validation-only";
  target: {
    /** Logical edge name; the same contract can be rendered for 88/44/HAOS/local. */
    host: string;
    /** Input interface carrying LAN traffic into the selected edge. */
    interface: string;
    candidate: { inboundTag: string; outboundTag: string };
    requiredChanges: string[];
  };
  ipSet: {
    name: string;
    source: string;
    refresh: "explicit";
    ipv4: string[];
    ipv6: string[];
  };
  tproxy: {
    required: true;
    enabled: false;
    listenAddress: string;
    listenPort: number;
    mode: "tcp+udp";
    mark: string;
    mask: string;
    kernelRequirements: string[];
  };
  rollback: {
    required: true;
    backupPattern: string;
    steps: string[];
  };
  deployment: {
    liveApply: false;
    liveTargets: string[];
    dryRunCommand: string;
  };
}

export interface TelegramTransparentLaneValidation {
  kind: "telegram-transparent-lane-validation";
  lane: "telegram-transparent";
  status: "validation-only";
  liveApply: false;
  ipSet: { name: string; source: string; entries: number };
  requirements: string[];
  rollback: string[];
  command: string;
}

export interface TelegramTransparentLaneCandidate {
  inbounds: Array<Record<string, any>>;
  routing: { rules: Array<Record<string, any>>; [key: string]: any };
  metadata: {
    lane: "telegram-transparent";
    liveApply: false;
    routerMode: "ipset+policy-routing";
    rollbackRequired: true;
  };
  [key: string]: any;
}

const CONFIG_PATH = path.join(process.cwd(), "deploy/server-88/telegram-transparent-lane.json");
const OFFICIAL_CIDR_SOURCE = "https://core.telegram.org/resources/cidr.txt";
/** Load the immutable canonical lane description used by validation and dry-run tooling. */
export async function loadTelegramTransparentLaneConfig(configPath = CONFIG_PATH): Promise<TelegramTransparentLaneConfig> {
  return JSON.parse(await readFile(configPath, "utf8")) as TelegramTransparentLaneConfig;
}

/** Validate that the lane describes prerequisites without claiming a live dataplane. */
export function validateTelegramTransparentLane(config: TelegramTransparentLaneConfig): void {
  if (config.schemaVersion !== 1 || config.lane !== "telegram-transparent") {
    throw new Error("unsupported Telegram transparent lane schema");
  }
  if (config.status !== "validation-only") throw new Error("Telegram lane must remain validation-only");
  if (!config.target.host.trim() || !config.target.interface.trim()) {
    throw new Error("Telegram lane target must define a non-empty edge host and interface");
  }
  if (!config.target.candidate.inboundTag || !config.target.candidate.outboundTag) {
    throw new Error("Telegram lane candidate must define inbound and outbound tags");
  }
  if (config.ipSet.source !== OFFICIAL_CIDR_SOURCE) {
    throw new Error(`Telegram IP-set source must be ${OFFICIAL_CIDR_SOURCE}`);
  }
  const entries = [...config.ipSet.ipv4, ...config.ipSet.ipv6];
  if (entries.length === 0 || new Set(entries).size !== entries.length) {
    throw new Error("Telegram IP-set must contain unique CIDR entries");
  }
  if (!config.tproxy.required || config.tproxy.enabled) {
    throw new Error("TPROXY must be required but disabled until a dataplane change is approved");
  }
  if (!config.tproxy.kernelRequirements.includes("CAP_NET_ADMIN")
      || !config.tproxy.kernelRequirements.includes("IP_TRANSPARENT")
      || !config.tproxy.kernelRequirements.includes("policy-routing")) {
    throw new Error("TPROXY kernel requirements are incomplete");
  }
  if (!config.rollback.required || config.rollback.steps.length === 0 || !config.rollback.backupPattern.includes("<UTC>")) {
    throw new Error("Telegram lane requires a timestamped rollback plan");
  }
  if (config.deployment.liveApply) throw new Error("liveApply must remain false for the first stage");
  if (config.deployment.liveTargets.length !== 0) throw new Error("liveTargets must remain empty for the first stage");
}

/** Render a deterministic artifact consumed by dry-run validation, never by deployment. */
export function renderTelegramTransparentLaneValidation(config: TelegramTransparentLaneConfig): TelegramTransparentLaneValidation {
  validateTelegramTransparentLane(config);
  return {
    kind: "telegram-transparent-lane-validation",
    lane: config.lane,
    status: config.status,
    liveApply: config.deployment.liveApply,
    ipSet: {
      name: config.ipSet.name,
      source: config.ipSet.source,
      entries: config.ipSet.ipv4.length + config.ipSet.ipv6.length,
    },
    requirements: [
      "TPROXY listener candidate is disabled",
      ...config.target.requiredChanges.map((change) => `requires ${change}`),
      ...config.tproxy.kernelRequirements.map((requirement) => `requires ${requirement}`),
    ],
    rollback: [
      `backup: ${config.rollback.backupPattern}`,
      ...config.rollback.steps,
    ],
    command: config.deployment.dryRunCommand,
  };
}

/**
 * Add the candidate transparent inbound to an existing server-88 Xray config.
 * This function only renders a detached candidate; it never writes a config or
 * changes the validation-only deployment state.
 */
export function renderTelegramTransparentLaneCandidate(
  baseConfig: Record<string, any>,
  config: TelegramTransparentLaneConfig,
): TelegramTransparentLaneCandidate {
  validateTelegramTransparentLane(config);
  if (!Array.isArray(baseConfig.inbounds)) throw new Error("server-88 Xray config is missing inbounds");
  if (!baseConfig.routing || !Array.isArray(baseConfig.routing.rules)) {
    throw new Error("server-88 Xray config is missing routing rules");
  }
  const inboundTag = config.target.candidate.inboundTag;
  const outboundTag = config.target.candidate.outboundTag;
  const outboundTags = new Set<string>([
    ...(Array.isArray(baseConfig.outbounds) ? baseConfig.outbounds.map((item: Record<string, any>) => item.tag) : []),
    ...(Array.isArray(baseConfig.routing.balancers) ? baseConfig.routing.balancers.map((item: Record<string, any>) => item.tag) : []),
  ]);
  if (Array.isArray(baseConfig.outbounds) && !outboundTags.has(outboundTag)) {
    throw new Error(`Telegram transparent lane requires outbound or balancer ${outboundTag}`);
  }
  const candidate = structuredClone(baseConfig) as TelegramTransparentLaneCandidate;
  candidate.inbounds = candidate.inbounds.filter((inbound) => inbound.tag !== inboundTag);
  candidate.routing.rules = candidate.routing.rules.filter(
    (rule) => rule.comment !== "vpn-panel:telegram-transparent-lane"
      && rule.comment !== "vpn-panel:github-transparent-route",
  );
  candidate.inbounds.push({
    tag: inboundTag,
    listen: config.tproxy.listenAddress,
    port: config.tproxy.listenPort,
    protocol: "dokodemo-door",
    settings: {
      network: config.tproxy.mode.replace("+", ","),
      followRedirect: true,
    },
    streamSettings: {
      sockopt: { tproxy: "tproxy" },
    },
    sniffing: {
      enabled: true,
      destOverride: ["http", "tls"],
      routeOnly: false,
    },
  });
  candidate.routing.rules.unshift({
    type: "field",
    inboundTag: [inboundTag],
    network: "tcp,udp",
    balancerTag: outboundTag,
    comment: "vpn-panel:telegram-transparent-lane",
  });
  candidate.metadata = {
    lane: "telegram-transparent",
    liveApply: false,
    routerMode: "ipset+policy-routing",
    rollbackRequired: true,
  };
  return candidate;
}
