#!/usr/bin/env python3
"""Read-only BrowserClaw probe for the owner's Upvel syscmd page.

It opens the page and submits only `pwd`.  The probe does not alter router
configuration, filesystem, DNS, routing, or Telnet state.
"""
import json
import re
import sys
import time
import urllib.request

URL = "http://127.0.0.1:9010/mcp"

if sys.argv[1:] == []:
    probe_command = "pwd"
elif sys.argv[1:] == ["--router-wifi-log"]:
    # Read-only BusyBox-compatible log collection; no radio/config operations.
    probe_command = "(logread 2>/dev/null; dmesg 2>/dev/null) | tail -n 240"
else:
    raise SystemExit("usage: upvel-browserclaw-readonly.py [--router-wifi-log]")


def post(payload, timeout=20, headers=False):
    session_id = payload.pop("sid", None)
    request_headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if session_id:
        request_headers["mcp-session-id"] = session_id
    request = urllib.request.Request(
        URL, data=json.dumps(payload).encode(), method="POST", headers=request_headers
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read().decode("utf-8", "replace")
        return (raw, dict(response.headers)) if headers else raw


def data(raw):
    for line in raw.splitlines():
        if line.startswith("data:"):
            try:
                return json.loads(line[5:].strip())
            except json.JSONDecodeError:
                continue
    return {}


def tool(sid, request_id, name, arguments, timeout=20):
    raw = post(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
            "sid": sid,
        },
        timeout,
    )
    return data(raw)


def list_tools(sid):
    return data(
        post({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "sid": sid})
    )


def text(result):
    return "\n".join(
        item.get("text", "")
        for item in result.get("result", {}).get("content", [])
        if item.get("type") == "text"
    )


def fail(message):
    print(json.dumps({"ok": False, "error": message}))
    raise SystemExit(1)


raw, initial_headers = post(
    {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "upvel-readonly-probe", "version": "1.0"},
        },
    },
    headers=True,
)
sid = initial_headers.get("mcp-session-id") or initial_headers.get("Mcp-Session-Id")
if not sid:
    fail("BrowserClaw did not return an MCP session id")

post({"jsonrpc": "2.0", "method": "notifications/initialized", "sid": sid})
tools = list_tools(sid)
tool_names = {item.get("name") for item in tools.get("result", {}).get("tools", [])}
if not {"tabs", "snapshot", "act", "wait"}.issubset(tool_names):
    fail("BrowserClaw tool inventory is missing tabs or snapshot")

opened = tool(sid, 3, "tabs", {"action": "new", "background": True, "url": "http://192.168.10.1/syscmd.htm"}, 30)
match = re.search(r"opened page (\d+)", text(opened))
if not match:
    fail("BrowserClaw did not report a new page id")
page = int(match.group(1))
tool(sid, 4, "wait", {"page": page, "value": 1200})
before = text(tool(sid, 5, "snapshot", {"page": page, "mode": "full"}))
controls = [
    line.strip()
    for line in before.splitlines()
    if "ref=" in line and any(kind in line.lower() for kind in ("textbox", "button", "input"))
][:20]

# Require the expected explicit command field and submit control.  If the page
# changed, stop rather than guessing BrowserClaw refs or submitting anything.
command_ref = re.search(r"textbox.*?\[ref=(e\d+)\]", before)
submit_ref = re.search(r"button\s+\"(?:Apply|Submit|Run|Запустить)\".*?\[ref=(e\d+)\]", before, re.I)
if not command_ref or not submit_ref:
    print(json.dumps({"ok": False, "error": "expected syscmd field/button refs were not present; no command submitted", "controls": controls}))
    raise SystemExit(1)

tool(sid, 6, "act", {"page": page, "kind": "fill", "fields": [{"ref": command_ref.group(1), "value": probe_command}]})
tool(sid, 7, "act", {"page": page, "kind": "click", "ref": submit_ref.group(1)})
time.sleep(1.5)
after = text(tool(sid, 8, "snapshot", {"page": page, "mode": "full"}))
outputs = re.findall(r"textbox.*?\[ref=e\d+\]: \"(.*?)\"", after, re.S)
page_evidence = text(
    tool(
        sid,
        9,
        "evaluate",
        {
            "page": page,
            "code": """
const scripts = [...document.scripts].map((script) => script.src || script.textContent);
const interesting = scripts
  .flatMap((source) => source.split(/\\n/))
  .filter((line) => /syscmd|ajax|xmlhttp|fetch\\(|\\.cgi|\\.asp|\\.htm/i.test(line))
  .map((line) => line.trim()).filter(Boolean).slice(0, 40);
return {
  forms: [...document.forms].map((form) => ({ action: form.action, method: form.method, fields: [...form.elements].map((field) => ({ name: field.name || field.id || field.type, value: field.type === 'password' ? '[redacted]' : field.value })) })),
  resources: performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => name.includes('192.168.10.1')).slice(-30),
  script_lines: interesting
};
""",
        },
    )
)

print(
    json.dumps(
        {
            "ok": True,
            "page": page,
            "command": probe_command,
            "browserclaw_tools": sorted(name for name in tool_names if name),
            "investigation_tool_schemas": {
                item["name"]: item.get("inputSchema", {})
                for item in tools.get("result", {}).get("tools", [])
                if item.get("name") in {"evaluate", "history", "read", "run"}
            },
            "form_changed": before != after,
            "output_textboxes": outputs[-3:],
            "page_evidence": page_evidence,
        }
    )
)
