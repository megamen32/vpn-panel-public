#!/usr/bin/env python3
"""SNI TCP edge proxy used with Smart DNS synthesized A records."""
import asyncio
import datetime
import signal

LISTEN_HOST = '127.0.0.1'
LISTEN_PORT = 9443
CONNECT_PORT = 443
CONNECT_TIMEOUT = 8
IDLE_TIMEOUT = 600
BLOCK_SUFFIXES = ('.local', '.lan')


def log(*args):
    print(datetime.datetime.utcnow().isoformat(timespec='seconds') + 'Z', *args, flush=True)


def parse_sni(data: bytes) -> str | None:
    try:
        if len(data) < 5 or data[0] != 0x16:
            return None
        record_len = int.from_bytes(data[3:5], 'big')
        if len(data) < 5 + record_len:
            return None
        pos = 5
        if data[pos] != 0x01:
            return None
        hs_len = int.from_bytes(data[pos + 1:pos + 4], 'big')
        end = pos + 4 + hs_len
        pos += 4 + 2 + 32
        sid_len = data[pos]
        pos += 1 + sid_len
        cs_len = int.from_bytes(data[pos:pos + 2], 'big')
        pos += 2 + cs_len
        comp_len = data[pos]
        pos += 1 + comp_len
        ext_len = int.from_bytes(data[pos:pos + 2], 'big')
        pos += 2
        ext_end = min(pos + ext_len, end)
        while pos + 4 <= ext_end:
            etype = int.from_bytes(data[pos:pos + 2], 'big')
            elen = int.from_bytes(data[pos + 2:pos + 4], 'big')
            pos += 4
            eend = pos + elen
            if etype == 0:
                q = pos + 2
                while q + 3 <= eend:
                    name_type = data[q]
                    name_len = int.from_bytes(data[q + 1:q + 3], 'big')
                    q += 3
                    if name_type == 0:
                        return data[q:q + name_len].decode('idna').strip('.').lower() or None
                    q += name_len
            pos = eend
    except Exception:
        return None
    return None


def allowed_host(host: str) -> bool:
    if not host or len(host) > 253 or host.endswith(BLOCK_SUFFIXES):
        return False
    if all(ch.isdigit() or ch == '.' for ch in host):
        return False
    return all(part and len(part) <= 63 for part in host.split('.'))


async def pipe(reader, writer):
    try:
        while True:
            chunk = await asyncio.wait_for(reader.read(65536), timeout=IDLE_TIMEOUT)
            if not chunk:
                break
            writer.write(chunk)
            await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


async def handle_client(client_reader, client_writer):
    peer = client_writer.get_extra_info('peername')
    first = b''
    try:
        while len(first) < 8192:
            chunk = await asyncio.wait_for(client_reader.read(4096), timeout=5)
            if not chunk:
                return
            first += chunk
            if parse_sni(first):
                break
            if len(first) >= 5 and len(first) >= 5 + int.from_bytes(first[3:5], 'big'):
                break
        sni = parse_sni(first)
        if not allowed_host(sni or ''):
            log('reject', peer, 'sni=', sni)
            return
        log('connect', peer, 'sni=', sni)
        upstream_reader, upstream_writer = await asyncio.wait_for(asyncio.open_connection(sni, CONNECT_PORT), timeout=CONNECT_TIMEOUT)
        upstream_writer.write(first)
        await upstream_writer.drain()
        await asyncio.gather(pipe(client_reader, upstream_writer), pipe(upstream_reader, client_writer))
        log('done', peer, 'sni=', sni)
    except Exception as e:
        log('error', peer, str(e))
    finally:
        try:
            client_writer.close()
            await client_writer.wait_closed()
        except Exception:
            pass


async def main():
    server = await asyncio.start_server(handle_client, LISTEN_HOST, LISTEN_PORT)
    log('listening', f'{LISTEN_HOST}:{LISTEN_PORT}')
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    async with server:
        await stop.wait()


if __name__ == '__main__':
    asyncio.run(main())
