#!/usr/bin/env python3
"""Smart DNS UDP/443 QUIC edge relay."""
import asyncio, json, logging, os, socket, ssl, time, urllib.parse, urllib.request
from pathlib import Path
CONFIG_PATH=os.environ.get('SMART_UDP_EDGE_CONFIG','/etc/smart-udp-edge/config.json')
LOG=logging.getLogger('smart-udp-edge')
class Config:
    def __init__(self,d):
        self.listen_host=d.get('listen_host','0.0.0.0'); self.listen_port=int(d.get('listen_port',443)); self.edge_map_url=d.get('edge_map_url','https://dns.bezrabotnyi.com/edge-map'); self.token=d.get('token',''); self.session_ttl=int(d.get('session_ttl_seconds',300)); self.map_cache_ttl=int(d.get('map_cache_ttl_seconds',30)); self.upstream_port=int(d.get('upstream_port',443)); self.dns_timeout=float(d.get('dns_timeout_seconds',3)); self.map_timeout=float(d.get('map_timeout_seconds',3)); self.log_denied=bool(d.get('log_denied',False)); self.max_sessions=int(d.get('max_sessions',4096))
class UpstreamProtocol(asyncio.DatagramProtocol):
    def __init__(self,server,client_addr): self.server=server; self.client_addr=client_addr
    def datagram_received(self,data,_addr):
        self.server.transport.sendto(data,self.client_addr)
        sess=self.server.sessions.get(self.client_addr)
        if sess: sess['last']=time.time(); sess['rx']+=1
class Server(asyncio.DatagramProtocol):
    def __init__(self,cfg): self.cfg=cfg; self.transport=None; self.sessions={}; self.map_cache={}
    def connection_made(self,transport): self.transport=transport; LOG.warning('listening udp %s:%s',self.cfg.listen_host,self.cfg.listen_port); asyncio.create_task(self.cleanup_loop())
    async def cleanup_loop(self):
        while True:
            await asyncio.sleep(30); now=time.time()
            for c,s in list(self.sessions.items()):
                if now-s['last']>self.cfg.session_ttl:
                    s['transport'].close(); self.sessions.pop(c,None)
            for ip,item in list(self.map_cache.items()):
                if item['until']<now: self.map_cache.pop(ip,None)
    def datagram_received(self,data,addr):
        if data: asyncio.create_task(self.handle(data,addr))
    async def handle(self,data,addr):
        now=time.time(); sess=self.sessions.get(addr)
        if sess and now<sess['until']:
            sess['last']=now; sess['tx']+=1; sess['transport'].sendto(data); return
        if len(self.sessions)>=self.cfg.max_sessions:
            if self.cfg.log_denied: LOG.warning('session limit, drop %s',addr)
            return
        mapping=await self.get_mapping(addr[0])
        if not mapping:
            if self.cfg.log_denied: LOG.warning('no map for %s',addr[0])
            return
        domain=mapping['domain']; port=int(mapping.get('port') or self.cfg.upstream_port)
        try:
            infos=await asyncio.wait_for(asyncio.get_running_loop().getaddrinfo(domain,port,family=socket.AF_INET,type=socket.SOCK_DGRAM),timeout=self.cfg.dns_timeout); upstream=infos[0][4]
        except Exception as e: LOG.warning('resolve fail %s for %s: %s',domain,addr[0],e); return
        old=self.sessions.pop(addr,None)
        if old: old['transport'].close()
        try: transport,_=await asyncio.get_running_loop().create_datagram_endpoint(lambda: UpstreamProtocol(self,addr),remote_addr=upstream)
        except Exception as e: LOG.warning('upstream socket fail %s -> %s: %s',addr,upstream,e); return
        until=min(mapping.get('until_ts') or (now+self.cfg.session_ttl), now+self.cfg.session_ttl)
        self.sessions[addr]={'domain':domain,'upstream':upstream,'transport':transport,'until':until,'last':now,'tx':1,'rx':0}
        LOG.info('session %s -> %s %s',addr,domain,upstream); transport.sendto(data)
    async def get_mapping(self,ip):
        now=time.time(); cached=self.map_cache.get(ip)
        if cached and cached['until']>now: return cached['value']
        def fetch():
            req=urllib.request.Request(self.cfg.edge_map_url+'?'+urllib.parse.urlencode({'ip':ip}),headers={'X-Edge-Auth-Token':self.cfg.token,'User-Agent':'smart-udp-edge/1'})
            with urllib.request.urlopen(req,timeout=self.cfg.map_timeout,context=ssl.create_default_context()) as r: return json.loads(r.read().decode())
        try:
            data=await asyncio.get_running_loop().run_in_executor(None,fetch)
            if not data.get('ok') or not data.get('domain'):
                self.map_cache[ip]={'until':now+2,'value':None}; return None
            value={'domain':data['domain'],'port':int(data.get('port') or self.cfg.upstream_port),'until_ts':min(float(data.get('until',0))/1000 if data.get('until') else now+86400, now+86400)}
            self.map_cache[ip]={'until':now+self.cfg.map_cache_ttl,'value':value}; return value
        except Exception as e:
            if self.cfg.log_denied: LOG.warning('map fetch fail %s: %s',ip,e)
            self.map_cache[ip]={'until':now+2,'value':None}; return None
async def main():
    logging.basicConfig(level=os.environ.get('LOG_LEVEL','INFO'),format='%(asctime)s %(levelname)s %(message)s')
    cfg=Config(json.loads(Path(CONFIG_PATH).read_text()))
    transport,_=await asyncio.get_running_loop().create_datagram_endpoint(lambda: Server(cfg),local_addr=(cfg.listen_host,cfg.listen_port))
    try: await asyncio.Future()
    finally: transport.close()
if __name__=='__main__': asyncio.run(main())
