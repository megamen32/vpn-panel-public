#!/usr/bin/env python3
"""Synchronize protected SmartDNS routing rules in a generated config file."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


PROTECTED_POLICY_PATH = Path(__file__).resolve().parent.parent / "deploy" / "smartdns" / "protected-policy.json"
PROXY_ONLY_FIELDS = (
    "directSuffixes",
    "directDomains",
    "hardDirectSuffixes",
    "hardDirectDomains",
    "localProxySuffixes",
    "localProxyDomains",
    "vusaProxySuffixes",
    "vusaProxyDomains",
)


def protected_proxy_suffixes() -> tuple[str, ...]:
    """Load and validate the proxy-only suffixes shared with TypeScript."""
    source = json.loads(PROTECTED_POLICY_PATH.read_text(encoding="utf-8"))
    if not isinstance(source, dict):
        raise ValueError(f"{PROTECTED_POLICY_PATH} must be a JSON object")
    values = source.get("proxyOnlySuffixes")
    if not isinstance(values, list):
        raise ValueError(f"{PROTECTED_POLICY_PATH} proxyOnlySuffixes must be an array")

    suffixes: list[str] = []
    for value in values:
        if not isinstance(value, str):
            raise ValueError(f"{PROTECTED_POLICY_PATH} proxyOnlySuffixes entries must be strings")
        normalized = value.strip().lower().strip(".")
        if not normalized:
            raise ValueError(f"{PROTECTED_POLICY_PATH} proxyOnlySuffixes entries must not be empty")
        if normalized not in suffixes:
            suffixes.append(normalized)
    if not suffixes:
        raise ValueError(f"{PROTECTED_POLICY_PATH} must define at least one proxy-only suffix")
    return tuple(suffixes)


def is_protected_proxy_suffix(value: object, suffixes: tuple[str, ...]) -> bool:
    """Return whether a config entry matches a protected suffix or its child."""
    if not isinstance(value, str):
        return False
    normalized = value.strip().lower().strip(".")
    return any(normalized == suffix or normalized.endswith(f".{suffix}") for suffix in suffixes)


def list_field(config: dict[str, Any], name: str) -> list[Any]:
    """Return a required config list or raise for a malformed generated config."""
    value = config.get(name)
    if not isinstance(value, list):
        raise ValueError(f"{name} must be an array")
    return value


def synchronize_protected_policy(config: dict[str, Any]) -> dict[str, Any]:
    """Make protected suffixes proxy-only while retaining unrelated config values."""
    suffixes = protected_proxy_suffixes()
    for field in PROXY_ONLY_FIELDS:
        config[field] = [
            value for value in list_field(config, field) if not is_protected_proxy_suffix(value, suffixes)
        ]

    proxy_suffixes = [
        value for value in list_field(config, "proxySuffixes") if not is_protected_proxy_suffix(value, suffixes)
    ]
    config["proxySuffixes"] = [*proxy_suffixes, *suffixes]
    return config


def main(argv: list[str]) -> int:
    """Update one generated SmartDNS JSON config in place.

    Args:
        argv: Command arguments containing exactly one JSON config path.

    Returns:
        Zero when the protected policy was synchronized.

    Raises:
        ValueError: If the generated config is not a JSON object with list fields.
    """
    if len(argv) != 2:
        raise ValueError("usage: sync-smartdns-protected-policy.py CONFIG_PATH")

    config_path = Path(argv[1])
    parsed = json.loads(config_path.read_text(encoding="utf-8"))
    if not isinstance(parsed, dict):
        raise ValueError("SmartDNS config must be a JSON object")

    synchronized = synchronize_protected_policy(parsed)
    config_path.write_text(json.dumps(synchronized, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
