import { Client } from "ssh2";
import type { ConnectConfig } from "ssh2";

export type VpsConnectionConfig = {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
};

export type VpsEngine = "xray" | "sing-box";

type VpsEngineProfile = {
  binaries: string[];
  config: string;
  unit: string;
  repository: string;
  archiveName: (version: string) => string;
};

const ENGINE_PROFILES: Record<VpsEngine, VpsEngineProfile> = {
  xray: {
    binaries: ["/usr/local/bin/xray", "/usr/bin/xray"],
    config: "/usr/local/etc/xray/config.json",
    unit: "xray",
    repository: "XTLS/Xray-core",
    archiveName: () => "Xray-linux-64.zip",
  },
  "sing-box": {
    binaries: ["/usr/local/bin/sing-box", "/usr/bin/sing-box"],
    config: "/etc/sing-box/config.json",
    unit: "sing-box",
    repository: "SagerNet/sing-box",
    archiveName: (version) => `sing-box-${version}-linux-amd64.tar.gz`,
  },
};

export type VpsSystemStats = {
  hostname: string;
  os: string;
  uptime_seconds: number;
  cpu_count: number;
  cpu_model: string;
  cpu_load_1m: number;
  cpu_load_5m: number;
  cpu_load_15m: number;
  mem_total_mb: number;
  mem_used_mb: number;
  mem_available_mb: number;
  disk_total_gb: number;
  disk_used_gb: number;
  disk_available_gb: number;
  disk_use_percent: number;
};

export type XrayStats = {
  name: string;
  value: number;
};

export type XrayUserTraffic = {
  email: string;
  uplink_bytes: number;
  downlink_bytes: number;
  online: boolean;
};

export type XrayInboundTraffic = {
  tag: string;
  uplink_bytes: number;
  downlink_bytes: number;
};

export type XrayLogEntry = {
  timestamp: string;
  message: string;
};

function connect(config: VpsConnectionConfig): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const sshConfig: ConnectConfig = {
      host: config.host,
      port: config.port,
      username: config.username,
      readyTimeout: 10000,
    };
    if (config.password) {
      sshConfig.password = config.password;
    }
    if (config.privateKey) {
      sshConfig.privateKey = config.privateKey;
      if (config.passphrase) sshConfig.passphrase = config.passphrase;
    }
    client.on("ready", () => resolve(client));
    client.on("error", (err: Error) => reject(err));
    client.connect(sshConfig);
  });
}

function exec(client: Client, command: string, timeout = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.end();
      reject(new Error(`SSH command timed out: ${command.slice(0, 80)}`));
    }, timeout);
    client.exec(command, (err: Error | undefined, stream: import("ssh2").ClientChannel) => {
      if (err) {
        clearTimeout(timer);
        return reject(err);
      }
      let stdout = "";
      let stderr = "";
      stream.on("data", (data: Buffer) => { stdout += data.toString(); });
      stream.on("stderr", (data: Buffer) => { stderr += data.toString(); });
      stream.on("close", (code: number | undefined) => {
        clearTimeout(timer);
        if (typeof code === "number" && code !== 0) {
          const detail = stderr.trim() || `exit code ${code}`;
          return reject(new Error(`SSH command failed: ${detail}`));
        }
        resolve(stdout);
      });
    });
  });
}

function engineBinaryCommand(engine: VpsEngine): string {
  const paths = ENGINE_PROFILES[engine].binaries.map((path) => `"${path}"`).join(" ");
  return `for binary in ${paths}; do if test -x "$binary"; then printf '%s' "$binary"; exit 0; fi; done; exit 1`;
}

async function resolveEngineBinary(client: Client, engine: VpsEngine): Promise<string> {
  return (await exec(client, engineBinaryCommand(engine))).trim();
}

export async function sshExec(config: VpsConnectionConfig, command: string, timeout = 15000): Promise<string> {
  const client = await connect(config);
  try {
    return await exec(client, command, timeout);
  } finally {
    client.end();
  }
}

export async function getSystemStats(config: VpsConnectionConfig): Promise<VpsSystemStats> {
  const client = await connect(config);
  try {
    const [hostname, os, uptime, cpu, loadavg, mem, disk] = await Promise.all([
      exec(client, "hostname -s 2>/dev/null || hostname"),
      exec(client, "cat /etc/os-release | grep PRETTY_NAME | cut -d'\"' -f2"),
      exec(client, "cat /proc/uptime | awk '{print int($1)}'"),
      exec(client, "lscpu | grep 'Model name' | head -1 | sed 's/Model name:\\s*//'"),
      exec(client, "cat /proc/loadavg | awk '{print $1,$2,$3}'"),
      exec(client, "free -m | awk '/Mem:/{print $2,$3,$7}'"),
      exec(client, "df -h / | awk 'NR==2{print $2,$3,$4,$5}'"),
    ]);

    const nproc = (await exec(client, "nproc")).trim();
    const loadParts = loadavg.trim().split(/\s+/);
    const memParts = mem.trim().split(/\s+/);
    const diskParts = disk.trim().split(/\s+/);

    return {
      hostname: hostname.trim(),
      os: os.trim() || "Linux",
      uptime_seconds: parseInt(uptime.trim()) || 0,
      cpu_count: parseInt(nproc) || 1,
      cpu_model: cpu.trim(),
      cpu_load_1m: parseFloat(loadParts[0]) || 0,
      cpu_load_5m: parseFloat(loadParts[1]) || 0,
      cpu_load_15m: parseFloat(loadParts[2]) || 0,
      mem_total_mb: parseFloat(memParts[0]) || 0,
      mem_used_mb: parseFloat(memParts[1]) || 0,
      mem_available_mb: parseFloat(memParts[2]) || 0,
      disk_total_gb: parseFloat(diskParts[0]) || 0,
      disk_used_gb: parseFloat(diskParts[1]) || 0,
      disk_available_gb: parseFloat(diskParts[2]) || 0,
      disk_use_percent: parseInt(diskParts[3]) || 0,
    };
  } finally {
    client.end();
  }
}

export async function getXrayStats(config: VpsConnectionConfig): Promise<XrayStats[]> {
  const client = await connect(config);
  try {
    let output: string;
    try {
      output = await exec(client, "/usr/local/bin/xray api statsquery --server=127.0.0.1:10085 2>/dev/null", 10000);
    } catch {
      return [];
    }
    try {
      const parsed = JSON.parse(output);
      return (parsed.stat || []).map((s: { name: string; value?: string }) => ({
        name: s.name,
        value: parseInt(s.value || "0") || 0,
      }));
    } catch {
      return [];
    }
  } finally {
    client.end();
  }
}

export async function getUserTraffic(config: VpsConnectionConfig): Promise<XrayUserTraffic[]> {
  const stats = await getXrayStats(config);
  const userMap = new Map<string, { up: number; down: number }>();

  for (const stat of stats) {
    const match = stat.name.match(/^user>>>(.+?)>>>traffic>>>(uplink|downlink)$/);
    if (match) {
      const email = match[1];
      const direction = match[2];
      if (!userMap.has(email)) {
        userMap.set(email, { up: 0, down: 0 });
      }
      const entry = userMap.get(email)!;
      if (direction === "uplink") entry.up = stat.value;
      else entry.down = stat.value;
    }
  }

  return Array.from(userMap.entries()).map(([email, traffic]) => ({
    email,
    uplink_bytes: traffic.up,
    downlink_bytes: traffic.down,
    online: false,
  }));
}

export async function getInboundTraffic(config: VpsConnectionConfig): Promise<XrayInboundTraffic[]> {
  const stats = await getXrayStats(config);
  const inboundMap = new Map<string, { up: number; down: number }>();

  for (const stat of stats) {
    const match = stat.name.match(/^inbound>>>(.+?)>>>traffic>>>(uplink|downlink)$/);
    if (match) {
      const tag = match[1];
      const direction = match[2];
      if (!inboundMap.has(tag)) {
        inboundMap.set(tag, { up: 0, down: 0 });
      }
      const entry = inboundMap.get(tag)!;
      if (direction === "uplink") entry.up = stat.value;
      else entry.down = stat.value;
    }
  }

  return Array.from(inboundMap.entries()).map(([tag, traffic]) => ({
    tag,
    uplink_bytes: traffic.up,
    downlink_bytes: traffic.down,
  }));
}

export async function getXrayConfig(config: VpsConnectionConfig): Promise<string> {
  return sshExec(config, "cat /usr/local/etc/xray/config.json");
}

async function writeConfigViaExec(client: Client, configJson: string): Promise<{ ok: boolean; error?: string }> {
  const b64 = Buffer.from(configJson, "utf8").toString("base64");

  const writeCmd = `python3 -c "
import base64
data = base64.b64decode('${b64}')
with open('/usr/local/etc/xray/config.pending.json', 'wb') as f:
    f.write(data)
print(len(data))
"`;
  const sizeOutput = await exec(client, writeCmd);
  const fileSize = parseInt(sizeOutput.trim());
  if (isNaN(fileSize) || fileSize < 100) {
    await exec(client, "rm -f /usr/local/etc/xray/config.pending.json");
    return { ok: false, error: `Config file too small (${sizeOutput.trim()} bytes)` };
  }

  const validation = await exec(client, "/usr/local/bin/xray run -test -config /usr/local/etc/xray/config.pending.json 2>&1");
  if (!validation.includes("Configuration OK")) {
    await exec(client, "rm -f /usr/local/etc/xray/config.pending.json");
    return { ok: false, error: validation.trim() };
  }

  await exec(client, "cp /usr/local/etc/xray/config.json /usr/local/etc/xray/config.json.bak");
  await exec(client, "mv /usr/local/etc/xray/config.pending.json /usr/local/etc/xray/config.json");
  return { ok: true };
}

export async function updateXrayConfig(config: VpsConnectionConfig, newConfig: string): Promise<{ ok: boolean; error?: string }> {
  const client = await connect(config);
  try {
    return await writeConfigViaExec(client, newConfig);
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    client.end();
  }
}

export async function restartXray(config: VpsConnectionConfig): Promise<{ ok: boolean; error?: string }> {
  try {
    const output = await sshExec(config, "systemctl restart xray 2>&1 && sleep 2 && systemctl is-active xray 2>&1");
    if (output.trim() === "active") {
      return { ok: true };
    }
    return { ok: false, error: output.trim() };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function parseLogs(output: string): XrayLogEntry[] {
  return output.trim().split("\n").filter(Boolean).map((line) => {
    const match = line.match(/^(\S+)\s+\S+\s+\S+:\s+(.+)$/);
    if (match) {
      return { timestamp: match[1], message: match[2] };
    }
    return { timestamp: "", message: line };
  });
}

function boundedLogLines(lines: number): number {
  return Math.max(1, Math.min(500, Math.trunc(lines)));
}

export async function getEngineLogs(config: VpsConnectionConfig, engine: VpsEngine, lines = 50): Promise<XrayLogEntry[]> {
  const profile = ENGINE_PROFILES[engine];
  const count = boundedLogLines(lines);
  const output = await sshExec(config, `journalctl -u ${profile.unit} --no-pager -n ${count} --output=short-iso 2>/dev/null || tail -n ${count} /var/log/${profile.unit}/access.log 2>/dev/null`);
  return parseLogs(output);
}

export async function getXrayLogs(config: VpsConnectionConfig, lines = 50): Promise<XrayLogEntry[]> {
  return getEngineLogs(config, "xray", lines);
}

export async function getEngineVersion(config: VpsConnectionConfig, engine: VpsEngine): Promise<string> {
  const binary = engineBinaryCommand(engine);
  const output = await sshExec(config, `binary=$(${binary}); "$binary" version 2>&1 | head -1`);
  return output.trim();
}

export async function getXrayVersion(config: VpsConnectionConfig): Promise<string> {
  return getEngineVersion(config, "xray");
}

export async function getSingBoxVersion(config: VpsConnectionConfig): Promise<string> {
  return getEngineVersion(config, "sing-box");
}

export async function getXrayStatus(config: VpsConnectionConfig): Promise<{ running: boolean; pid: number | null; memory_mb: number; cpu_time: string; uptime: string }> {
  return getEngineStatus(config, "xray");
}

export async function getEngineStatus(config: VpsConnectionConfig, engine: VpsEngine): Promise<{ running: boolean; pid: number | null; memory_mb: number; cpu_time: string; uptime: string }> {
  const unit = ENGINE_PROFILES[engine].unit;
  const output = await sshExec(config, `systemctl show ${unit} --property=ActiveState,MainPID --no-pager 2>/dev/null`);
  const running = output.includes("ActiveState=active");

  let pid: number | null = null;
  let memoryMb = 0;
  let cpuTime = "";
  let uptime = "";

  if (running) {
    const pidMatch = output.match(/MainPID=(\d+)/);
    pid = pidMatch ? parseInt(pidMatch[1]) : null;

    const psOutput = await sshExec(config, `ps -p ${pid || `$(pgrep ${unit} | head -1)`} -o rss=,cputime=,etime= --no-headers 2>/dev/null || echo ""`);
    const parts = psOutput.trim().split(/\s+/);
    if (parts.length >= 3) {
      memoryMb = Math.round(parseInt(parts[0]) / 1024);
      cpuTime = parts[1];
      uptime = parts[2];
    }
  }

  return { running, pid, memory_mb: memoryMb, cpu_time: cpuTime, uptime };
}

type InboundClient = { id: string; email: string; flow?: string };

function updateClientsInConfig(existingConfig: Record<string, unknown>, clientMap: Map<string, InboundClient[]>): Record<string, unknown> {
  const config = JSON.parse(JSON.stringify(existingConfig)) as Record<string, unknown>;
  const inbounds = config.inbounds as Array<Record<string, unknown>> | undefined;
  if (!inbounds) return config;

  for (const inbound of inbounds) {
    const tag = String(inbound.tag || "");
    const clients = clientMap.get(tag);
    if (clients) {
      const settings = inbound.settings as Record<string, unknown> | undefined;
      if (settings) {
        settings.clients = clients.map((c) => {
          const entry: Record<string, string> = { id: c.id, email: c.email };
          if (c.flow) entry.flow = c.flow;
          return entry;
        });
      }
    }
  }

  return config;
}

export async function syncXrayClients(
  config: VpsConnectionConfig,
  clientMap: Map<string, InboundClient[]>,
): Promise<{ ok: boolean; error?: string }> {
  const client = await connect(config);
  try {
    const existingJson = await exec(client, "cat /usr/local/etc/xray/config.json");
    let existingConfig: Record<string, unknown>;
    try {
      existingConfig = JSON.parse(existingJson);
    } catch {
      return { ok: false, error: "Failed to parse existing config on VPS" };
    }

    const updated = updateClientsInConfig(existingConfig, clientMap);
    const configStr = JSON.stringify(updated, null, 2);

    const writeResult = await writeConfigViaExec(client, configStr);
    if (!writeResult.ok) return writeResult;

    const restartOutput = await exec(client, "systemctl restart xray 2>&1 && sleep 2 && systemctl is-active xray 2>&1");
    if (restartOutput.trim() === "active") {
      return { ok: true };
    }
    return { ok: false, error: restartOutput.trim() };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    client.end();
  }
}

export async function resetTrafficStats(config: VpsConnectionConfig): Promise<{ ok: boolean }> {
  try {
    await sshExec(config, "/usr/local/bin/xray api stats --server=127.0.0.1:10085 --reset 2>/dev/null");
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export type XrayRelease = {
  version: string;
  tag: string;
  prerelease: boolean;
  download_url: string;
  release_notes: string;
  published_at: string;
};

export type XrayUpdateInfo = {
  current_version: string;
  releases: XrayRelease[];
};

function parseVersion(v: string): number[] {
  return v.split(".").map(Number);
}

function cleanEngineVersion(output: string): string {
  const match = output.match(/(?:Xray|sing-box)(?:\s+version)?\s+v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i);
  return match?.[1] || output.trim().split(/\s+/)[0] || "";
}

function isNewer(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return true;
    if (na < nb) return false;
  }
  return false;
}

export async function checkEngineUpdate(config: VpsConnectionConfig, engine: VpsEngine): Promise<XrayUpdateInfo> {
  const profile = ENGINE_PROFILES[engine];
  const currentVersion = await getEngineVersion(config, engine);
  const currentClean = cleanEngineVersion(currentVersion);
  const releasesJson = await new Promise<string>((resolve, reject) => {
    import("node:https").then((https) => {
      https.get(`https://api.github.com/repos/${profile.repository}/releases?per_page=20`, {
        headers: { "User-Agent": "vpn-panel" },
      }, (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => resolve(data));
        res.on("error", reject);
      }).on("error", reject);
    });
  });

  const raw = JSON.parse(releasesJson);
  const releases: XrayRelease[] = (raw || [])
    .filter((r: { tag_name?: string }) => r.tag_name)
    .map((r: { tag_name: string; prerelease: boolean; body: string; published_at: string; assets: Array<{ name: string; browser_download_url: string }> }) => {
      const version = r.tag_name.replace(/^v/, "");
      const linuxAsset = r.assets?.find((a) => a.name === `Xray-linux-64.zip`);
      const asset = r.assets?.find((candidate) => candidate.name === profile.archiveName(version));
      return {
        version,
        tag: r.tag_name,
        prerelease: r.prerelease,
        download_url: asset?.browser_download_url || linuxAsset?.browser_download_url || `https://github.com/${profile.repository}/releases/download/${r.tag_name}/${profile.archiveName(version)}`,
        release_notes: r.body || "",
        published_at: r.published_at,
      };
    });

  return { current_version: currentClean, releases };
}

export async function checkXrayUpdate(config: VpsConnectionConfig): Promise<XrayUpdateInfo> {
  return checkEngineUpdate(config, "xray");
}

export async function checkSingBoxUpdate(config: VpsConnectionConfig): Promise<XrayUpdateInfo> {
  return checkEngineUpdate(config, "sing-box");
}

export type XrayUpdateResult = {
  ok: boolean;
  old_version?: string;
  new_version?: string;
  error?: string;
};

export async function updateEngine(config: VpsConnectionConfig, engine: VpsEngine, targetVersion: string): Promise<XrayUpdateResult> {
  const profile = ENGINE_PROFILES[engine];
  const cleanTarget = targetVersion.trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(cleanTarget)) {
    return { ok: false, error: "Invalid version format" };
  }
  const client = await connect(config);
  const binary = await resolveEngineBinary(client, engine);
  const tempDir = `/tmp/vpn-panel-${engine === "xray" ? "xray" : "sing-box"}-update-${Date.now()}`;
  const archivePath = `${tempDir}/archive`;
  const candidatePath = `${tempDir}/${engine === "xray" ? "xray" : "sing-box"}`;
  const backupPath = `${binary}.bak_update_${Date.now()}`;
  let wasActive = false;
  try {
    const oldVersion = (await exec(client, `"${binary}" version 2>&1 | head -1`)).trim();
    const releaseInfo = await checkEngineUpdate(config, engine);
    const release = releaseInfo.releases.find((item) => item.version === cleanTarget);
    if (!release?.download_url) return { ok: false, error: `Release asset not found for ${engine} ${cleanTarget}` };

    await exec(client, `mkdir -p ${tempDir}`);
    await exec(client, `curl -fsSL --retry 3 -o ${archivePath} "${release.download_url}"`, 120000);
    if (engine === "xray") {
      await exec(client, `unzip -oq ${archivePath} xray -d ${tempDir} && chmod 0755 ${candidatePath}`);
    } else {
      await exec(client, `tar -xzf ${archivePath} -C ${tempDir} --strip-components=1 && chmod 0755 ${candidatePath}`);
    }
    await exec(client, `test -x ${candidatePath} && ${candidatePath} version 2>&1 | head -1`);
    wasActive = (await exec(client, `systemctl is-active ${profile.unit} 2>/dev/null || true`)).trim() === "active";
    const configExists = (await exec(client, `test -r "${profile.config}" && printf yes || printf no`)).trim() === "yes";
    if (engine === "xray" && !configExists) throw new Error(`Missing ${profile.config}`);
    await exec(client, `cp -a "${binary}" "${backupPath}"`);
    if (wasActive) await exec(client, `systemctl stop ${profile.unit}`, 15000);
    await exec(client, `install -m 0755 ${candidatePath} "${binary}"`);
    if (configExists) {
      if (engine === "xray") {
        await exec(client, `"${binary}" run -test -config "${profile.config}" 2>&1 | grep -q "Configuration OK"`);
      } else {
        await exec(client, `"${binary}" check -c "${profile.config}"`);
      }
    }
    if (wasActive) await exec(client, `systemctl start ${profile.unit} && sleep 2 && systemctl is-active ${profile.unit}`, 30000);
    const newVersion = (await exec(client, `"${binary}" version 2>&1 | head -1`)).trim();
    await exec(client, `rm -rf ${tempDir}`);

    return {
      ok: true,
      old_version: cleanEngineVersion(oldVersion),
      new_version: cleanEngineVersion(newVersion),
    };
  } catch (err) {
    try {
      await exec(client, `test -f "${backupPath}" && cp "${backupPath}" "${binary}"`);
      if (wasActive) await exec(client, `systemctl start ${profile.unit} 2>/dev/null || true`);
    } catch { /* best effort rollback */ }
    try { await exec(client, `rm -rf ${tempDir}`); } catch { /* best effort cleanup */ }
    return { ok: false, error: String(err) };
  } finally {
    client.end();
  }
}

export async function updateXray(config: VpsConnectionConfig, targetVersion: string): Promise<XrayUpdateResult> {
  return updateEngine(config, "xray", targetVersion);
}

export async function updateSingBox(config: VpsConnectionConfig, targetVersion: string): Promise<XrayUpdateResult> {
  return updateEngine(config, "sing-box", targetVersion);
}
