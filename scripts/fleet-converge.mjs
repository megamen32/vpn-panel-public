#!/usr/bin/env node
/**
 * fleet-converge — one script for every VPN Panel VPS.
 *
 * Why this exists: scripts/deploy-reality-443.sh was hardcoded to a single
 * host (VPN2_HOST="vpn2.bezrabotnyi.com"), so each node was configured by a
 * different one-off path. The fleet drifted into three different shapes:
 * different xray config paths, Reality on a public port on one node and
 * loopback on another, 12 clients on two nodes and 3 on the third, and no
 * nginx at all on the smallest one.
 *
 * The client list is the concrete defect this fixes first. The database holds
 * the authoritative set of enabled clients; every node must carry exactly that
 * set on its Reality inbound. One node had an extra stale client, another was
 * missing eight.
 *
 * Layout (config path, Reality port, bind, nginx presence) is converged to the
 * canonical shape declared in deploy/vpn-fleet.json under "_canonical":
 * DPI blocks every public port except 443, so nginx owns 443 and rotates by
 * SNI to a loopback Reality port.
 *
 * Usage:
 *   node scripts/fleet-converge.mjs            # report drift, changes nothing
 *   node scripts/fleet-converge.mjs --clients  # also sync the client list
 *   node scripts/fleet-converge.mjs --clients --host=vpn2
 *
 * Never prints keys, passwords or private material.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const repoDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fleet = JSON.parse(
  readFileSync(path.join(repoDir, "deploy/vpn-fleet.json"), "utf8"),
);
const canonical = fleet._canonical;

const args = process.argv.slice(2);
const applyClients = args.includes("--clients");
const only = args.find((a) => a.startsWith("--host="))?.slice(7);

const log = (...m) => console.log(...m);
const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const warn = (s) => `\x1b[33m${s}\x1b[0m`;

/** Run a shell command on a fleet host. Passwords only via env, never argv. */
function onHost(host, spec, script) {
  const base = [
    "ssh",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=no",
  ];
  let cmd;
  if (spec.sshPasswordEnv && process.env[spec.sshPasswordEnv]) {
    cmd = [
      "sshpass", "-e", "ssh",
      "-o", "StrictHostKeyChecking=no",
      "-o", "ConnectTimeout=10",
      "-o", "PreferredAuthentications=password",
      spec.ssh,
      script,
    ];
  } else {
    cmd = [...base, spec.ssh, script];
  }
  const env = spec.sshPasswordEnv
    ? { ...process.env, SSHPASS: process.env[spec.sshPasswordEnv] || "" }
    : process.env;
  return spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8", env, timeout: 120000 });
}

/** Enabled clients straight from the database — the one source of truth. */
async function enabledClients() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows } = await pool.query(`
      select c.xray_uuid::text as uuid, a.login
      from vpn_clients c
      join accounts a on a.id = c.account_id
      where c.enabled and a.enabled
      order by a.login`);
    return rows.map((r) => r.uuid);
  } finally {
    await pool.end();
  }
}

/**
 * Ship a Python program to a host as base64.
 * Inline heredocs get mangled by JSON stringification plus two shells, so the
 * payload is base64-encoded here and decoded remotely.
 */
function pythonOnHost(spec, py, args = []) {
  const b64 = Buffer.from(py, "utf8").toString("base64");
  const tmp = `/tmp/fleet-converge-${hostSuffix(spec)}.py`;
  const quoted = args.map((a) => `'${a}'`).join(" ");
  const script =
    `echo ${b64} | base64 -d > ${tmp} && python3 ${tmp} ${quoted}; rm -f ${tmp}`;
  return onHost(spec.ssh, spec, script);
}

function hostSuffix(spec) {
  let h = 0;
  for (const c of spec.ssh) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h).toString(36);
}

/** Read the Reality inbound client ids from a host, plus its layout facts. */
function inspect(spec) {
  const py = `import json, sys
cfg_path = sys.argv[1]
try:
    cfg = json.load(open(cfg_path))
except Exception as exc:
    print(json.dumps({"error": "cannot read %s: %s" % (cfg_path, exc)}))
    raise SystemExit(1)
out = {"reality": None, "inbound_ports": []}
for i in cfg.get("inbounds", []):
    st = i.get("streamSettings") or {}
    out["inbound_ports"].append({
        "port": i.get("port"),
        "listen": i.get("listen", "0.0.0.0"),
        "protocol": i.get("protocol"),
        "security": st.get("security"),
        "network": st.get("network"),
    })
    if st.get("security") == "reality":
        clients = ((i.get("settings") or {}).get("clients")) or []
        out["reality"] = {
            "port": i.get("port"),
            "listen": i.get("listen", "0.0.0.0"),
            "ids": [c.get("id") for c in clients],
            "flow": clients[0].get("flow") if clients else None,
        }
print(json.dumps(out))
`;
  const res = pythonOnHost(spec, py, [spec.xrayConfigPath]);
  if (res.status !== 0) return { error: ((res.stdout || "") + (res.stderr || "")).trim().slice(0, 300) };
  try {
    return JSON.parse(res.stdout.trim().split("\n").pop());
  } catch (e) {
    return { error: `unparseable: ${(res.stdout || "").slice(0, 200)}` };
  }
}

/** Rewrite the Reality client list on a host, validating before it restarts. */
function syncClients(spec, wanted) {
  const py = `import json, sys, shutil, subprocess, datetime, os
cfg_path, wanted_path = sys.argv[1], sys.argv[2]
wanted = set(json.load(open(wanted_path)))
cfg = json.load(open(cfg_path))
targets = [i for i in cfg.get("inbounds", [])
           if (i.get("streamSettings") or {}).get("security") == "reality"]
if not targets:
    print(json.dumps({"ok": False, "error": "no Reality inbound"}))
    raise SystemExit(1)
t = targets[0]
clients = ((t.get("settings") or {}).get("clients")) or []
have = {c.get("id") for c in clients}
if have == wanted:
    print(json.dumps({"ok": True, "changed": False, "clients": len(wanted)}))
    raise SystemExit(0)
flow = next((c.get("flow") for c in clients if c.get("flow")), "xtls-rprx-vision")
t["settings"]["clients"] = [
    {"id": u, "email": u[:8], "flow": flow} for u in sorted(wanted)
]
stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
root = os.path.dirname(cfg_path)
backup = os.path.join(root, os.path.basename(cfg_path) + ".fleetbak-" + stamp)
shutil.copy2(cfg_path, backup)
open(cfg_path, "w").write(json.dumps(cfg, ensure_ascii=False, indent=2) + "\\n")
check = subprocess.run(["/usr/local/bin/xray", "run", "-test", "-c", cfg_path],
                       capture_output=True, text=True)
if check.returncode != 0:
    shutil.copy2(backup, cfg_path)
    print(json.dumps({"ok": False, "error": "xray -test failed, rolled back",
                      "detail": (check.stderr or "").strip()[-300:]}))
    raise SystemExit(1)
print(json.dumps({"ok": True, "changed": True, "clients": len(wanted), "backup": backup}))
`;
  // Pass the wanted list through a file so nothing sensitive lands in argv.
  const tmp = `/tmp/fleet-wanted-${hostSuffix(spec)}.json`;
  const payload = Buffer.from(JSON.stringify(wanted), "utf8").toString("base64");
  const pre = onHost(spec.ssh, spec,
    `echo ${payload} | base64 -d > ${tmp} && chmod 600 ${tmp} && ` +
    `python3 /dev/stdin ${spec.xrayConfigPath} ${tmp} <<'FLEETPY'\n${py}\nFLEETPY\n`);
  if (pre.status !== 0) {
    return { ok: false, error: ((pre.stdout || "") + (pre.stderr || "")).slice(-300) };
  }
  let parsed;
  try {
    parsed = JSON.parse(pre.stdout.trim().split("\n").pop());
  } catch {
    return { ok: false, error: (pre.stdout || "").slice(-300) };
  }
  if (parsed.ok && parsed.changed) {
    onHost(spec.ssh, spec, "systemctl restart xray.service && sleep 2 && systemctl is-active xray.service");
  }
  return parsed;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }
  const wanted = await enabledClients();
  log(`database: ${wanted.length} enabled clients (authoritative)\n`);

  const aliases = Object.keys(fleet).filter((k) => !k.startsWith("_"));
  const targets = only ? aliases.filter((a) => a === only) : aliases;
  if (!targets.length) {
    console.error(`no such fleet alias: ${only}`);
    process.exit(2);
  }

  let drift = 0;
  for (const alias of targets) {
    const spec = fleet[alias];
    log(`===== ${alias} (${spec.label}) =====`);
    const info = inspect(spec);

    // Host-local service accounts (e.g. the server-100 relay's dedicated
    // Reality identity for the Finland host) are not vpn_clients rows, but
    // they must survive every sync or the host stops serving that relay.
    const service = spec.serviceClients || [];
    const wantedHere = [...wanted, ...service.filter((u) => !wanted.includes(u))];
    if (service.length) log(`  service clients: ${service.length} declared in fleet spec`);

    if (info.error) {
      log(`  ${bad("inspect failed")}: ${info.error}`);
      drift++;
      continue;
    }

    // client set
    const haveIds = new Set(info.reality?.ids || []);
    const missing = wantedHere.filter((u) => !haveIds.has(u));
    const extra = (info.reality?.ids || []).filter((u) => !wantedHere.includes(u));
    if (!info.reality) {
      log(`  ${bad("no Reality inbound found")}`);
      drift++;
    } else if (missing.length || extra.length) {
      drift++;
      log(`  Reality :${info.reality.port} on ${info.reality.listen}`);
      log(`  clients : ${bad(`${haveIds.size} != ${wantedHere.length}`)}`);
      if (missing.length) log(`    missing: ${missing.length} client(s)`);
      if (extra.length) log(`    ${warn(`extra: ${extra.length} stale client(s)`)}`);
    } else {
      log(`  ${ok("clients")}  ${haveIds.size}/${wantedHere.length} match`);
    }

    // layout vs canonical
    const layoutIssues = [];
    if (spec.xrayConfigPath !== canonical.xrayConfigPath) {
      layoutIssues.push(`config ${spec.xrayConfigPath} -> ${canonical.xrayConfigPath}`);
    }
    if (info.reality && info.reality.port !== canonical.realityPort) {
      layoutIssues.push(`Reality ${info.reality.port} -> ${canonical.realityPort}`);
    }
    if (info.reality && info.reality.listen !== canonical.realityBind) {
      layoutIssues.push(`bind ${info.reality.listen} -> ${canonical.realityBind}`);
    }
    if (spec.nginxStream !== canonical.nginxStream) {
      layoutIssues.push(`nginx stream: ${spec.nginxStream} -> ${canonical.nginxStream}`);
    }
    if (layoutIssues.length) {
      drift++;
      log(`  ${warn("layout drift")}:`);
      for (const issue of layoutIssues) log(`    - ${issue}`);
    } else {
      log(`  ${ok("layout")}   matches canonical`);
    }
    log(`  inbounds: ${info.inbound_ports.map((i) => `${i.port}/${i.security || i.protocol}`).join(" ")}`);
    log("");

    if (applyClients && (missing.length || extra.length) && info.reality) {
      const res = syncClients(spec, wantedHere);
      if (res.ok) {
        log(res.changed
          ? `  ${ok("clients synced")} -> ${res.clients} (backup ${res.backup})`
          : `  clients already correct`);
      } else {
        log(`  ${bad("client sync failed")}: ${res.error || ""}`);
        drift++;
      }
      log("");
    }
  }

  log("=".repeat(64));
  log(drift ? `${warn(`${drift} node(s) drifted`)}` : ok("fleet matches canonical"));
  if (!applyClients) log("re-run with --clients to apply the client-list fix");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});