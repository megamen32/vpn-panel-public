#!/usr/bin/env python3
"""Register the managed three-server fleet without printing transport credentials."""
import json, os, pathlib, sys, datetime

root = pathlib.Path(__file__).resolve().parent.parent
fleet = json.loads((root / 'deploy/vpn-fleet.json').read_text())
path = pathlib.Path(os.environ.get('VPN_PANEL_SECURE_CONFIG', '/etc/vpn-panel/secure.json'))
before = path.read_bytes()
stat = path.stat()
secure = json.loads(before)
servers = secure.setdefault('vps_list', [])
if not any(v.get('host') in ['31.76.43.193', 'fi-vpn.bezrabotnyi.com'] for v in servers):
    servers.append(dict(id='finland-helsinki', host='31.76.43.193', port=22,
        username='root', label='Finland Helsinki VPN', password='', passphrase='',
        private_key=pathlib.Path('/home/roomhacker/.ssh/id_rsa').read_text()))

enabled = set(sys.argv[1:])
allowed = {t['endpoint'] for t in fleet.values()} | {'de-xhttp-h2'}
if not enabled <= allowed:
    raise SystemExit('unknown endpoint selection')
for target in fleet.values():
    if target['endpoint'] not in enabled:
        continue
    node = next((n for n in secure['nodes'] if n['id'] == target['endpoint']), None)
    values = dict(id=target['endpoint'], label=target['label'] + ' · Hysteria2', enabled=True,
        public_catalog=True, kind='hysteria2', address=target['address'], port=24443,
        sni=target['domain'], query={'sni': target['domain']}, profiles=[target['endpoint']])
    if node is None:
        secure['nodes'].append(values)
    else:
        node.update(values)
if 'de-xhttp-h2' in enabled:
    node = next(n for n in secure['nodes'] if n['id'] == 'de-xhttp-h2')
    node.update(enabled=True, public_catalog=True)

after = (json.dumps(secure, indent=2, ensure_ascii=False) + '\n').encode()
if json.loads(before) == secure:
    print('fleet registration unchanged')
    raise SystemExit(0)
if path.read_bytes() != before:
    raise SystemExit('secure configuration changed concurrently; retry')
backup = path.with_name('secure.before-fleet-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S') + '.json')
backup.write_bytes(before); backup.chmod(0o600); os.chown(backup, stat.st_uid, stat.st_gid)
candidate = path.with_name('secure.fleet-candidate.json')
candidate.write_bytes(after); candidate.chmod(0o600); os.chown(candidate, stat.st_uid, stat.st_gid)
os.replace(candidate, path)
print('Finland registered; selected endpoints:', ','.join(sorted(enabled)) or 'unchanged')
