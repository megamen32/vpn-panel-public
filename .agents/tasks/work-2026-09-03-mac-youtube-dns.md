# Mac YouTube LAN Smart Edge recovery

Started at 2026-09-03T14:56:16+03:00 (manual clock; `/proc/uptime` 152048.66s)
Estimate: minimum 10 active minutes / maximum 25 active minutes.
Status: complete

## Минимальный путь

- Результат: YouTube открывается на Mac `user@192.168.2.8` через LAN Smart Edge без системного proxy.
- Реальная канарейка: системный DNS Mac возвращает `192.168.2.1` для YouTube, затем HTTPS и браузерная загрузка YouTube проходят с самого Mac.
- YAGNI-срез: убрать DNS bypass от Wi-Fi/Tailscale и вернуть системный DNS на OpenWrt `192.168.2.1`, не меняя Tailscale-маршруты.
- Не делаем: включение системного HTTP/SOCKS proxy, изменение глобальной SmartDNS-политики или transparent fallback.

## Evidence

- Red: Wi-Fi DNS is `1.1.1.1`; Tailscale `CorpDNS=true`; system lookup returns real Google IPs and direct YouTube TLS times out.
- Control: explicit router proxies `3127` and `3128` return HTTP 301 from YouTube on the same Mac.
- Fix: `tailscale set --accept-dns=false`; Wi-Fi DNS changed from `1.1.1.1` to `192.168.2.1`. Tailscale remains running with routes enabled.
- Green CLI: system lookup returns `192.168.2.1`; direct TLS verifies and YouTube returns HTTP/2 301.
- First browser check was rejected after the user supplied the actual offline screenshot; title/URL alone was not sufficient acceptance evidence.
- Second root cause: the HAOS Smart Edge add-on was `state: stopped`, so both `:443` and `:3127` refused connections. It was started through Supervisor and remains `boot: auto`, `running healthy`, restart count `0`.
- Green browser: all existing YouTube tabs were reloaded after edge recovery; two watch pages expose their full video titles and `loading=false`, and the YouTube home tab is loaded.
- Final Mac canary: direct `https://www.youtube.com/` returned HTTP 200 via remote IP `192.168.2.1` in 0.745s.
- Screenshot boundary: macOS rejected SSH `screencapture` because Screen Recording permission is unavailable; the user-provided offline screenshot served as failure evidence, followed by browser tab state and direct real-Mac network proof.
