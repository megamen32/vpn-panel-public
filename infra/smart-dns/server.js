#!/usr/bin/env node
'use strict';

const http = require('http');
const tls = require('tls');
const net = require('net');
const dgram = require('dgram');
const fs = require('fs');

const cfg = JSON.parse(fs.readFileSync(process.env.SMART_DNS_CONFIG || '/opt/smart-dns/config.json', 'utf8'));
const localClients = cfg.clients || {};
let clients = { ...localClients };
let directSuffixes = (cfg.directSuffixes || []).map(norm);
let proxySuffixes = (cfg.proxySuffixes || []).map(norm);
let directDomains = new Set((cfg.directDomains || []).map(norm));
const hardDirectSuffixes = (cfg.hardDirectSuffixes || [
  'github.com',
  'githubusercontent.com',
  'githubassets.com',
  'github.io',
]).map(norm);
const hardDirectDomains = new Set((cfg.hardDirectDomains || [
  'github.com',
  'www.github.com',
  'ssh.github.com',
  'api.github.com',
  'gist.github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'github.githubassets.com',
]).map(norm));
let proxyDomains = new Set((cfg.proxyDomains || []).map(norm));
const directDns = cfg.directDns || { host: '1.1.1.1', port: 53, timeoutMs: 3000 };
const httpProxy = cfg.httpProxy || { host: '127.0.0.1', port: 3128, timeoutMs: 5000 };
const proxyDoh = cfg.proxyDoh || { urlHost: 'cloudflare-dns.com', path: '/dns-query', port: 443, timeoutMs: 7000 };
const dohListen = cfg.dohListen || { host: '0.0.0.0', port: 8053 };
const dotListen = cfg.dotListen || { host: '0.0.0.0', port: 8853 };
const baseDotName = norm(cfg.baseDotName || 'dns.bezrabotnyi.com');
const sync = cfg.sync || null;
const smartEdge = cfg.smartEdge || null;

function norm(s) { return String(s || '').trim().toLowerCase().replace(/\.$/, ''); }
function hasSuffix(name, suffixes) { const n = norm(name); return suffixes.some(s => n === s || n.endsWith('.' + s)); }
function log(...a) { console.log(new Date().toISOString(), ...a); }

function applyRuntimePayload(payload) {
  if (!payload || payload.ok !== true) throw new Error('bad sync payload');
  const remoteClients = {};
  for (const client of payload.clients || []) {
    const clientId = String(client.clientId || client.client_id || '').trim();
    if (!clientId || client.enabled !== true) continue;
    remoteClients[clientId] = {
      enabled: true,
      mode: client.mode || 'non_ru_via_proxy',
      defaultRoute: client.defaultRoute || payload.policy?.defaultRoute || 'proxy',
      accountId: client.accountId || client.account_id || null,
      login: client.login || null,
    };
  }
  if (payload.policy) {
    directSuffixes = (payload.policy.directSuffixes || directSuffixes).map(norm);
    proxySuffixes = (payload.policy.proxySuffixes || proxySuffixes).map(norm);
    directDomains = new Set((payload.policy.directDomains || [...directDomains]).map(norm));
    proxyDomains = new Set((payload.policy.proxyDomains || [...proxyDomains]).map(norm));
  }
  clients = { ...localClients, ...remoteClients };
  return { remote: Object.keys(remoteClients).length, total: Object.keys(clients).length };
}

async function syncRuntimeClients() {
  if (!sync?.url) return;
  const headers = { accept: 'application/json' };
  if (sync.token) headers.authorization = `Bearer ${sync.token}`;
  const res = await fetch(sync.url, { headers, signal: AbortSignal.timeout(sync.timeoutMs || 5000) });
  if (!res.ok) throw new Error(`sync http ${res.status}`);
  const stats = applyRuntimePayload(await res.json());
  log('sync ok', `remote=${stats.remote}`, `total=${stats.total}`);
}

function startSync() {
  if (!sync?.url) return;
  syncRuntimeClients().catch((e) => log('sync error', e.message));
  setInterval(() => syncRuntimeClients().catch((e) => log('sync error', e.message)), sync.intervalMs || 30000).unref();
}

function checkClient(id) {
  const raw = String(id || '');
  for (const k of [raw, raw.toLowerCase(), raw.toUpperCase()]) {
    const c = clients[k];
    if (c && c.enabled === true) return { id: k, ...c };
  }
  return null;
}

function clientFromDoh(url) {
  const u = new URL(url, 'http://x');
  const parts = u.pathname.split('/').filter(Boolean);
  return parts[0] === 'dns-query' ? parts[1] : null;
}

function clientFromSni(servername) {
  const s = norm(servername);
  if (s.endsWith('.' + baseDotName)) return s.slice(0, -(baseDotName.length + 1));
  return null;
}

function question(buf) {
  if (buf.length < 12) throw new Error('short dns packet');
  let off = 12; const labels = [];
  while (off < buf.length) {
    const len = buf[off++];
    if ((len & 0xc0) === 0xc0) throw new Error('compressed qname unsupported');
    if (len === 0) break;
    labels.push(buf.subarray(off, off + len).toString('ascii'));
    off += len;
  }
  if (off + 4 > buf.length) throw new Error('missing qtype');
  return { qname: norm(labels.join('.')), qtype: buf.readUInt16BE(off), qclass: buf.readUInt16BE(off + 2), questionEnd: off + 4 };
}

function routeFor(qname, client) {
  const q = norm(qname);
  // Hard safety bypasses: these must never be synthetic/fake-routed, even if
  // remote policy sync says defaultRoute=proxy. SSH host keys and git pushes
  // depend on github.com resolving directly.
  if (hardDirectDomains.has(q) || hasSuffix(q, hardDirectSuffixes)) return 'direct';
  if (directDomains.has(q) || hasSuffix(q, directSuffixes)) return 'direct';
  if (proxyDomains.has(q) || hasSuffix(q, proxySuffixes)) return 'proxy';
  return client.mode === 'non_ru_via_proxy' ? 'proxy' : (client.defaultRoute || 'direct');
}

function udpDns(query) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => { sock.close(); reject(new Error('direct dns timeout')); }, directDns.timeoutMs || 3000);
    sock.once('error', e => { clearTimeout(timer); sock.close(); reject(e); });
    sock.once('message', msg => { clearTimeout(timer); sock.close(); resolve(msg); });
    sock.send(query, directDns.port || 53, directDns.host || '1.1.1.1');
  });
}

function proxyTunnel(host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(httpProxy.port || 3128, httpProxy.host || '127.0.0.1');
    let acc = Buffer.alloc(0);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('proxy timeout')); }, httpProxy.timeoutMs || 5000);
    sock.on('connect', () => sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
    sock.once('error', e => { clearTimeout(timer); reject(e); });
    sock.on('data', function onData(chunk) {
      acc = Buffer.concat([acc, chunk]);
      const i = acc.indexOf('\r\n\r\n');
      if (i < 0) return;
      clearTimeout(timer); sock.removeListener('data', onData);
      const head = acc.subarray(0, i).toString('latin1');
      if (!/^HTTP\/1\.[01] 200\b/.test(head)) return reject(new Error('CONNECT failed: ' + head.split('\r\n')[0]));
      const rest = acc.subarray(i + 4); if (rest.length) sock.unshift(rest);
      resolve(sock);
    });
  });
}

async function dohViaProxy(query) {
  const host = proxyDoh.urlHost || 'cloudflare-dns.com';
  const sock = await proxyTunnel(host, proxyDoh.port || 443);
  return new Promise((resolve, reject) => {
    const ts = tls.connect({ socket: sock, servername: host, ALPNProtocols: ['http/1.1'] });
    let acc = Buffer.alloc(0);
    const timer = setTimeout(() => { ts.destroy(); reject(new Error('proxied doh timeout')); }, proxyDoh.timeoutMs || 7000);
    ts.once('secureConnect', () => {
      ts.write(`POST ${proxyDoh.path || '/dns-query'} HTTP/1.1\r\nHost: ${host}\r\nAccept: application/dns-message\r\nContent-Type: application/dns-message\r\nContent-Length: ${query.length}\r\nConnection: close\r\n\r\n`);
      ts.write(query);
    });
    ts.on('data', c => { acc = Buffer.concat([acc, c]); });
    ts.once('error', e => { clearTimeout(timer); reject(e); });
    ts.once('end', () => {
      clearTimeout(timer);
      const i = acc.indexOf('\r\n\r\n');
      const head = acc.subarray(0, i).toString('latin1');
      if (i < 0 || !/^HTTP\/1\.[01] 200\b/.test(head)) return reject(new Error('DoH upstream failed'));
      resolve(acc.subarray(i + 4));
    });
  });
}

async function resolveDns(query, client, proto) {
  const q = question(query);
  const route = routeFor(q.qname, client);
  const start = Date.now();
  const synthetic = syntheticEdgeAnswer(query, q, route);
  const ans = synthetic || (route === 'proxy' ? await dohViaProxy(query) : await udpDns(query));
  log(proto, client.id, route, synthetic ? 'edge' : 'resolve', q.qname, 'qtype=' + q.qtype, Date.now() - start + 'ms');
  return ans;
}

function servfail(query) {
  const out = Buffer.from(query);
  if (out.length >= 12) { out.writeUInt16BE((out.readUInt16BE(2) | 0x8080) & 0xfff0 | 2, 2); out.writeUInt16BE(0, 6); out.writeUInt16BE(0, 8); out.writeUInt16BE(0, 10); }
  return out;
}

function noAnswer(query) {
  const out = Buffer.from(query);
  if (out.length >= 12) {
    out.writeUInt16BE((out.readUInt16BE(2) | 0x8080) & 0xfff0, 2);
    out.writeUInt16BE(0, 6); out.writeUInt16BE(0, 8); out.writeUInt16BE(0, 10);
  }
  return out;
}

function aAnswer(query, q, ip, ttl) {
  const parts = String(ip || '').split('.').map(x => Number(x));
  if (parts.length !== 4 || parts.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return servfail(query);
  const questionBuf = query.subarray(12, q.questionEnd || query.length);
  const out = Buffer.alloc(12 + questionBuf.length + 16);
  query.copy(out, 0, 0, 12);
  out.writeUInt16BE((out.readUInt16BE(2) | 0x8080) & 0xfff0, 2);
  out.writeUInt16BE(1, 4); out.writeUInt16BE(1, 6); out.writeUInt16BE(0, 8); out.writeUInt16BE(0, 10);
  questionBuf.copy(out, 12);
  let off = 12 + questionBuf.length;
  out.writeUInt16BE(0xc00c, off); off += 2;
  out.writeUInt16BE(1, off); off += 2;
  out.writeUInt16BE(1, off); off += 2;
  out.writeUInt32BE(ttl || 60, off); off += 4;
  out.writeUInt16BE(4, off); off += 2;
  for (const part of parts) out[off++] = part;
  return out;
}

function syntheticEdgeAnswer(query, q, route) {
  if (!smartEdge || smartEdge.enabled !== true || route !== 'proxy' || q.qclass !== 1) return null;
  if (q.qtype === 1) return aAnswer(query, q, smartEdge.ipv4, smartEdge.ttl || 60);
  if (q.qtype === 28 || q.qtype === 65) return noAnswer(query);
  return null;
}

startSync();

http.createServer(async (req, res) => {
  try {
    const client = checkClient(clientFromDoh(req.url));
    if (!client) return res.writeHead(403, { 'content-type': 'text/plain' }).end('client disabled or unknown');
    let query;
    if (req.method === 'GET') {
      const b64 = new URL(req.url, 'http://x').searchParams.get('dns');
      query = b64 && Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    } else if (req.method === 'POST') {
      const chunks = []; for await (const c of req) chunks.push(c); query = Buffer.concat(chunks);
    } else return res.writeHead(405, { allow: 'GET, POST' }).end();
    if (!query || query.length < 12 || query.length > 4096) return res.writeHead(400).end('bad dns query');
    const ans = await resolveDns(query, client, 'doh');
    res.writeHead(200, { 'content-type': 'application/dns-message', 'cache-control': 'no-store' });
    res.end(ans);
  } catch (e) { log('doh error', e.message); res.writeHead(500).end('dns error'); }
}).listen(dohListen.port, dohListen.host, () => log('DoH listening', `${dohListen.host}:${dohListen.port}`));

if (cfg.tls?.certFile && cfg.tls?.keyFile) {
  const tlsOpts = { cert: fs.readFileSync(cfg.tls.certFile), key: fs.readFileSync(cfg.tls.keyFile) };
  tls.createServer(tlsOpts, (socket) => {
    const client = checkClient(clientFromSni(socket.servername));
    if (!client) { log('dot reject', socket.remoteAddress, socket.servername || '-'); socket.destroy(); return; }
    let acc = Buffer.alloc(0);
    socket.on('data', async chunk => {
      acc = Buffer.concat([acc, chunk]);
      while (acc.length >= 2) {
        const len = acc.readUInt16BE(0);
        if (len < 12 || len > 4096) return socket.destroy();
        if (acc.length < 2 + len) return;
        const query = acc.subarray(2, 2 + len); acc = acc.subarray(2 + len);
        let ans; try { ans = await resolveDns(query, client, 'dot'); } catch (e) { log('dot error', e.message); ans = servfail(query); }
        const p = Buffer.alloc(2); p.writeUInt16BE(ans.length, 0); socket.write(Buffer.concat([p, ans]));
      }
    });
  }).listen(dotListen.port, dotListen.host, () => log('DoT listening', `${dotListen.host}:${dotListen.port}`));
}
