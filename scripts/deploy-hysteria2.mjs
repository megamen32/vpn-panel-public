#!/usr/bin/env node
// Run on the controller with DATABASE_URL. No credentials in argv or output.
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const host = args.find(a => a.startsWith('--host='))?.slice(7);
const targets = JSON.parse(readFileSync(new URL('../deploy/vpn-fleet.json', import.meta.url), 'utf8'));
if (host && !Object.hasOwn(targets, host)) throw new Error('unknown host');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const { rows } = await pool.query(`select distinct c.xray_uuid::text as auth
    from vpn_clients c join accounts a on a.id=c.account_id
    where c.enabled and a.enabled order by auth`);
  if (!rows.length) throw new Error('refusing an empty user configuration');
  for (const [alias, target] of Object.entries(targets)) {
    if (host && alias !== host) continue;
    const { domain } = target;
    const config = {
      log: { loglevel: 'warning' },
      inbounds: [{ tag: 'hy2', listen: '0.0.0.0', port: 24443, protocol: 'hysteria',
        settings: { version: 2, users: rows.map(row => ({ auth: row.auth })) },
        streamSettings: { network: 'hysteria', security: 'tls',
          tlsSettings: { alpn: ['h3'], certificates: [{
            certificateFile: `/etc/letsencrypt/live/${domain}/fullchain.pem`,
            keyFile: `/etc/letsencrypt/live/${domain}/privkey.pem`,
          }] },
          hysteriaSettings: { version: 2, masquerade: { type: 'string', content: 'OK', statusCode: 200 } },
        },
      }],
      outbounds: [{ protocol: 'freedom', tag: 'direct' }, { protocol: 'blackhole', tag: 'block' }],
      routing: { rules: [{ type: 'field', ip: ['10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '::1/128', 'fc00::/7', 'fe80::/10'], outboundTag: 'block' }] },
    };
    if (!apply) { console.log(`${alias}: candidate UDP24443, ${rows.length} enabled users; --apply to deploy`); continue; }
    const unit = `[Unit]\nDescription=VPN Panel Hysteria2 transport\nAfter=network-online.target\nWants=network-online.target\nStartLimitIntervalSec=60\nStartLimitBurst=6\n[Service]\nExecStart=/usr/local/bin/xray run -config /etc/vpn-panel/hysteria2.json\nRestart=always\nRestartSec=3\nLimitNOFILE=65536\nMemoryMax=192M\nNoNewPrivileges=true\n[Install]\nWantedBy=multi-user.target\n`;
    // The remote helper receives the sensitive payload only on stdin. Validate
    // before activation; preserve the previous file if activation fails.
    const helper = `import json,sys,pathlib,subprocess,os,datetime,hashlib
p=json.load(sys.stdin);root=pathlib.Path('/etc/vpn-panel');root.mkdir(mode=0o700,exist_ok=True)
dest=root/'hysteria2.json';candidate=root/'hysteria2.candidate.json'
unit=pathlib.Path('/etc/systemd/system/vpn-hysteria2.service')
body=json.dumps(p['config'],sort_keys=True,indent=2)+'\\n'
changed=not dest.exists() or dest.read_text()!=body or not unit.exists() or unit.read_text()!=p['unit']
if changed:
 candidate.write_text(body);candidate.chmod(0o600)
 check=subprocess.run(['/usr/local/bin/xray','run','-test','-config',str(candidate)],capture_output=True)
 if check.returncode: candidate.unlink();sys.exit('candidate validation failed (private configuration withheld)')
 previous=dest.read_bytes() if dest.exists() else None
 if previous is not None:
  backup=root/('hysteria2.backup-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S')+'.json');backup.write_bytes(previous);backup.chmod(0o600)
 os.replace(candidate,dest);unit.write_text(p['unit']);unit.chmod(0o644)
 subprocess.run(['systemctl','daemon-reload'],check=True)
 r=subprocess.run(['systemctl','restart','vpn-hysteria2'],capture_output=True)
 if r.returncode:
  if previous is not None: dest.write_bytes(previous);dest.chmod(0o600);subprocess.run(['systemctl','restart','vpn-hysteria2'])
  sys.exit('activation failed; previous configuration restored when available')
subprocess.run(['systemctl','enable','vpn-hysteria2'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
subprocess.run(['systemctl','start','vpn-hysteria2'],check=True)
print('updated' if changed else 'unchanged')
`;
    const quoted = "'" + helper.replaceAll("'", "'\\''") + "'";
    const result = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', target.ssh, `python3 -c ${quoted}`], {
      input: JSON.stringify({ config, unit }), encoding: 'utf8', timeout: 30000,
    });
    if (result.status !== 0) throw new Error(`${alias}: deployment failed: ${result.stderr?.slice(-300) || 'SSH/helper error'}`);
    console.log(`${alias}: ${result.stdout.trim()}, users=${rows.length}`);
  }
} finally { await pool.end(); }
