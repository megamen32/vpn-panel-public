#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TARGETS_FILE = process.env.VPN_PANEL_SMART_EDGE_TARGETS || path.join(ROOT, 'data', 'smart-edge-targets.json');
const STATE_FILE = process.env.VPN_PANEL_SMART_EDGE_STATE || path.join(ROOT, 'data', 'smart-edge-state.json');
const SECURE_CONFIG_FILE = process.env.VPN_PANEL_SECURE_CONFIG || process.env.VPN_PANEL_CONFIG || '/etc/vpn-panel/secure.json';
const SMART_DNS_HOST = process.env.VPN_PANEL_SMART_DNS_HOST || 'localhost';
const SMART_DNS_CONFIG = process.env.VPN_PANEL_SMART_DNS_CONFIG || '/opt/smart-dns/config.json';
const SMART_DNS_SERVICE = process.env.VPN_PANEL_SMART_DNS_SERVICE || 'smart-dns.service';

const PRESETS = {
  vusa: {
    id: 'vusa', label: 'vusa / US edge', publicIp: '185.240.120.152', streamConfigPath: '/etc/nginx/stream-smart-edge.conf',
    ownSni: ['vusa.bezrabotnyi.com', 'tgweb.demiurge.space'], ownBackend: '127.0.0.1:8444', edgeBackend: '127.0.0.1:9443',
    specialRoutes: [
      { sni: '.t.gptadmin.bezrabotnyi.com', backend: '127.0.0.1:8446', label: 'GPTAdmin vhost' },
      { sni: 'www.google.com', backend: '127.0.0.1:23443', label: 'Reality' },
      { sni: 'google.com', backend: '127.0.0.1:23443', label: 'Reality' },
      { sni: 'smart-de.runet.bezrabotnyi.com', backend: '95.165.165.65:443', label: 'Mobile Smart DE relay' },
      { sni: 'full-de.runet.bezrabotnyi.com', backend: '95.165.165.65:443', label: 'Mobile Full DE relay' },
    ],
  },
  vpn2: {
    id: 'vpn2', label: 'vpn2 / DE edge', publicIp: '212.192.31.128', streamConfigPath: '/etc/nginx/stream-smart-edge.conf',
    obsoleteStreamConfigPaths: ['/etc/nginx/stream-reality.conf'],
    streamAccessLog: true,
    ownSni: ['vpn2.bezrabotnyi.com', 'cdn.demiurge.space', 'cdn2.demiurge.space'], ownBackend: '127.0.0.1:8444', edgeBackend: '127.0.0.1:9443',
    specialRoutes: [
      { sni: '.t.gptadmin.bezrabotnyi.com', backend: '127.0.0.1:8446', label: 'GPTAdmin tunnel' },
      { sni: '.v.gptadmin.bezrabotnyi.com', backend: '127.0.0.1:8445', label: 'GPTAdmin vhost' },
      { sni: 'ya.ru', backend: '127.0.0.1:23443', label: 'Reality' },
      { sni: 'smart-us.runet.bezrabotnyi.com', backend: '95.165.165.65:443', label: 'Mobile Smart US relay' },
      { sni: 'full-us.runet.bezrabotnyi.com', backend: '95.165.165.65:443', label: 'Mobile Full US relay' },
    ],
  },
};

const DEFAULT_TARGETS = [
  { ...PRESETS.vusa, sshHost: 'vusa.bezrabotnyi.com', sshUser: 'root', sshPort: 22, source: 'default' },
  { ...PRESETS.vpn2, sshHost: 'vpn2.bezrabotnyi.com', sshUser: 'root', sshPort: 22, source: 'default' },
];

function run(cmd, args, opts = {}) {
  console.log('+', cmd, ...args.map(a => String(a)));
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.status !== 0) throw new Error(`${cmd} failed with code ${res.status}`);
  return res;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; return fallback; }
}

function canonicalEdgeId(value) {
  const v = String(value || '').toLowerCase();
  if (v.includes('vusa') || v.includes('185-240-120-152') || v.includes('185.240.120.152')) return 'vusa';
  if (v.includes('vpn2') || v.includes('212-192-31-128') || v.includes('212.192.31.128')) return 'vpn2';
  return null;
}

function normalizeTarget(t) {
  if (!t?.id || !t?.sshHost || !t?.publicIp) return null;
  return {
    id: String(t.id), label: String(t.label || t.id), sshHost: String(t.sshHost), sshUser: String(t.sshUser || 'root'), sshPort: Number(t.sshPort || 22), publicIp: String(t.publicIp),
    streamConfigPath: String(t.streamConfigPath || '/etc/nginx/stream-smart-edge.conf'), ownSni: Array.isArray(t.ownSni) ? t.ownSni.map(String) : [],
    obsoleteStreamConfigPaths: Array.isArray(t.obsoleteStreamConfigPaths) ? t.obsoleteStreamConfigPaths.map(String).filter(Boolean) : [],
    streamAccessLog: Boolean(t.streamAccessLog),
    ownBackend: String(t.ownBackend || '127.0.0.1:8444'), edgeBackend: String(t.edgeBackend || '127.0.0.1:9443'),
    specialRoutes: Array.isArray(t.specialRoutes) ? t.specialRoutes.filter(r => r?.sni && r?.backend).map(r => ({ sni: String(r.sni), backend: String(r.backend), label: r.label ? String(r.label) : undefined })) : [],
    source: t.source || 'override',
  };
}

function targetsFromSecureConfig() {
  const secure = readJson(SECURE_CONFIG_FILE, null);
  if (!secure?.vps_list?.length) return DEFAULT_TARGETS;
  const targets = [];
  for (const vps of secure.vps_list) {
    const presetId = canonicalEdgeId(`${vps.id} ${vps.host}`);
    const preset = presetId ? PRESETS[presetId] : null;
    targets.push({
      ...(preset || { id: String(vps.id), publicIp: String(vps.host), streamConfigPath: '/etc/nginx/stream-smart-edge.conf', ownSni: [String(vps.host)], ownBackend: '127.0.0.1:8444', edgeBackend: '127.0.0.1:9443', specialRoutes: [] }),
      id: preset?.id || String(vps.id),
      label: String(vps.label || preset?.label || vps.id),
      sshHost: String(vps.host),
      sshUser: String(vps.username || 'root'),
      sshPort: Number(vps.port || 22),
      source: 'secure.vps_list',
    });
  }
  return targets.length ? targets : DEFAULT_TARGETS;
}

function loadTargets() {
  const customRaw = readJson(TARGETS_FILE, []);
  const custom = Array.isArray(customRaw) ? customRaw : Array.isArray(customRaw.targets) ? customRaw.targets : [];
  const byId = new Map(targetsFromSecureConfig().map(t => [t.id, t]));
  for (const item of custom) {
    const t = normalizeTarget(item);
    if (t) byId.set(t.id, t);
  }
  return [...byId.values()];
}

function targetById(id) {
  const target = loadTargets().find(t => t.id === id);
  if (!target) throw new Error(`unknown target: ${id}. Known: ${loadTargets().map(t => t.id).join(', ')}`);
  return target;
}

function sshArgs(t) { return ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-p', String(t.sshPort || 22)]; }
function sshTarget(t) { return `${t.sshUser}@${t.sshHost}`; }
function ssh(t, command) { return run('ssh', [...sshArgs(t), sshTarget(t), command]); }
function scp(t, local, remote) { return run('scp', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-P', String(t.sshPort || 22), local, `${sshTarget(t)}:${remote}`]); }
function smartDnsCommand(command) {
  if (SMART_DNS_HOST === 'localhost' || SMART_DNS_HOST === '127.0.0.1') return run('bash', ['-lc', command]);
  return run('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', SMART_DNS_HOST, command]);
}

function streamConfig(t) {
  const map = [];
  const upstreams = [];
  let idx = 0;
  for (const route of t.specialRoutes) {
    const name = `special_${idx++}`;
    map.push(`        ${route.sni.padEnd(34)} ${name};`);
    upstreams.push(`    upstream ${name} { server ${route.backend}; }`);
  }
  for (const sni of t.ownSni) map.push(`        ${sni.padEnd(34)} own_https_backend;`);
  map.push('        default                            smart_edge_backend;');
  upstreams.push(`    upstream own_https_backend { server ${t.ownBackend}; }`);
  upstreams.push(`    upstream smart_edge_backend { server ${t.edgeBackend}; }`);
  const hostnames = t.specialRoutes.some((route) => route.sni.includes('*') || route.sni.startsWith('.')) || t.ownSni.some((sni) => sni.includes('*') || sni.startsWith('.'));
  const mapHeader = hostnames ? '        hostnames;\n' : '';
  const accessLog = t.streamAccessLog
    ? `    log_format stream_fmt '$remote_addr [$time_local] $protocol $status $bytes_sent $bytes_received $ssl_preread_server_name $upstream_addr';\n    access_log /var/log/nginx/stream-access.log stream_fmt;\n    error_log /var/log/nginx/stream-error.log error;\n\n`
    : '';
  return `# Managed by vpn-panel Smart Edge deploy\n# target: ${t.id} / ${t.label}\nstream {\n${accessLog}    map $ssl_preread_server_name $smart_edge_backend_name {\n${mapHeader}${map.join('\n')}\n    }\n\n${upstreams.join('\n')}\n\n    server {\n        listen 443;\n        proxy_pass $smart_edge_backend_name;\n        ssl_preread on;\n        proxy_timeout 600s;\n        proxy_connect_timeout 5s;\n    }\n}\n`;
}

function httpRedirectConfig() {
  return `# Managed by vpn-panel Smart Edge deploy\n# HTTP edge fallback: unknown HTTP requests are redirected to HTTPS so SNI edge can handle them.\nserver {\n    listen 80 default_server;\n    listen [::]:80 default_server;\n    server_name _;\n    return 301 https://$host$request_uri;\n}\n`;
}

function obsoleteIncludeCleanup(target) {
  return (target.obsoleteStreamConfigPaths || []).map((configPath) => {
    if (!/^\/etc\/nginx\/[A-Za-z0-9._/-]+$/.test(configPath)) {
      throw new Error(`unsafe obsolete nginx config path for ${target.id}: ${configPath}`);
    }
    const escapedPath = configPath.replace(/[\\.^$*+?()[\]{}|]/g, "\\$&");
    return `sed -i '\\|include[[:space:]]\\+${escapedPath};|d' /etc/nginx/nginx.conf`;
  }).join('\n');
}

function deploy(targetId) {
  const t = targetById(targetId);
  const removeObsoleteIncludes = obsoleteIncludeCleanup(t);
  const tmp = fs.mkdtempSync('/tmp/smart-edge-deploy-');
  const stream = path.join(tmp, 'stream.conf');
  const httpRedirect = path.join(tmp, 'http-redirect.conf');
  const goRoot = path.join(ROOT, 'scripts', 'smartedge-go');
  const smartEdgeBinary = path.join(tmp, 'smart-edge');
  fs.writeFileSync(stream, streamConfig(t));
  fs.writeFileSync(httpRedirect, httpRedirectConfig());
  run('go', ['test', './...'], { cwd: goRoot });
  run('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', smartEdgeBinary, '.'], {
    cwd: goRoot,
    env: { ...process.env, CGO_ENABLED: '0' },
  });
  scp(t, smartEdgeBinary, '/tmp/smart-edge');
  scp(t, path.join(ROOT, 'infra/smart-edge/smart-edge.service'), '/tmp/smart-edge.service');
  scp(t, stream, '/tmp/smart-edge-stream.conf');
  scp(t, httpRedirect, '/tmp/smart-edge-http-redirect.conf');
  ssh(t, `set -euo pipefail
TS=$(date +%Y%m%d_%H%M%S)
install -m 0755 /tmp/smart-edge /usr/local/bin/smart-edge
install -m 0644 /tmp/smart-edge.service /etc/systemd/system/smart-edge.service
NGINX_BACKUP=/etc/nginx/nginx.conf.bak.smart-edge.$TS
STREAM_BACKUP='${t.streamConfigPath}.bak.smart-edge.'$TS
STREAM_EXISTED=0
cp -a /etc/nginx/nginx.conf "$NGINX_BACKUP"
if [ -f '${t.streamConfigPath}' ]; then
  cp -a '${t.streamConfigPath}' "$STREAM_BACKUP"
  STREAM_EXISTED=1
fi
install -m 0644 /tmp/smart-edge-stream.conf '${t.streamConfigPath}'
${removeObsoleteIncludes}
if ! grep -Fq "include ${t.streamConfigPath};" /etc/nginx/nginx.conf; then
  printf '\n# vpn-panel Smart Edge stream routing\ninclude ${t.streamConfigPath};\n' >> /etc/nginx/nginx.conf
fi
install -m 0644 /tmp/smart-edge-http-redirect.conf /etc/nginx/sites-available/smart-edge-http-redirect
# A transparent Smart DNS HTTP edge already owns default_server :80 on the
# deployed VPSes. Do not add a second default server beside it.
if [ -e /etc/nginx/sites-enabled/smart-edge-transparent-http ]; then
  rm -f /etc/nginx/sites-enabled/smart-edge-http-redirect
else
  ln -sf /etc/nginx/sites-available/smart-edge-http-redirect /etc/nginx/sites-enabled/smart-edge-http-redirect
fi
test -x /usr/local/bin/smart-edge
if ! nginx -t; then
  cp -a "$NGINX_BACKUP" /etc/nginx/nginx.conf
  if [ "$STREAM_EXISTED" = 1 ]; then
    cp -a "$STREAM_BACKUP" '${t.streamConfigPath}'
  else
    rm -f '${t.streamConfigPath}'
  fi
  nginx -t || true
  exit 1
fi
systemctl daemon-reload
systemctl enable --now smart-edge.service
systemctl reload nginx
systemctl status smart-edge.service --no-pager -n 20
printf '\n--- SNI probe own ---\n'
echo | timeout 10 openssl s_client -connect 127.0.0.1:443 -servername '${t.ownSni[0] || t.sshHost}' -brief 2>&1 | sed -n '1,35p'
printf '\n--- SNI probe httpbin ---\n'
echo | timeout 10 openssl s_client -connect 127.0.0.1:443 -servername httpbin.org -brief 2>&1 | sed -n '1,35p'
printf '\n--- HTTP redirect probe ---\n'
curl -sS -I --resolve httpbin.org:80:${t.publicIp} http://httpbin.org/ip | sed -n '1,8p'
`);
  console.log(`deployed Smart Edge on ${t.id} (${t.publicIp})`);
}

function saveState(patch) {
  const current = readJson(STATE_FILE, { activeEdgeId: 'vusa' });
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2) + '\n');
  return next;
}

function selectPrimary(targetId) {
  const t = targetById(targetId);
  const py = `import json\np='${SMART_DNS_CONFIG}'\nc=json.load(open(p))\npublic=c.setdefault('edgeProfiles',{}).setdefault('public',{})\npublic.update({'enabled': True, 'ipv4': '${t.publicIp}', 'ipv4s': ['${t.publicIp}'], 'ttl': 60})\nc.pop('smartEdge',None)\nopen(p,'w').write(json.dumps(c,indent=2,ensure_ascii=False)+'\\n')\nprint(public)\n`;
  smartDnsCommand(`set -euo pipefail
sudo python3 - <<'PY'
${py}PY
sudo systemctl restart ${SMART_DNS_SERVICE}
sudo systemctl status ${SMART_DNS_SERVICE} --no-pager -n 15
`);
  saveState({ activeEdgeId: targetId, lastPrimaryIp: t.publicIp });
  console.log(`selected primary Smart Edge: ${targetId} ${t.publicIp}`);
}

function validate(targetId) {
  const t = targetById(targetId);
  ssh(t, `set -euo pipefail
systemctl is-active smart-edge.service
nginx -t
printf 'httpbin via edge: '
curl -4 -fsS --resolve httpbin.org:443:${t.publicIp} https://httpbin.org/ip
printf '\nhttp redirect: '
curl -sS -I --resolve httpbin.org:80:${t.publicIp} http://httpbin.org/ip | sed -n '1,2p'
`);
}

const [action, targetId] = process.argv.slice(2);
if (!['deploy', 'render', 'select-primary', 'validate'].includes(action || '') || !targetId) {
  console.error('Usage: smart-edge-deploy.mjs <deploy|render|select-primary|validate> <target-id>');
  process.exit(2);
}
if (action === 'deploy') deploy(targetId);
if (action === 'render') process.stdout.write(streamConfig(targetById(targetId)));
if (action === 'select-primary') selectPrimary(targetId);
if (action === 'validate') validate(targetId);
