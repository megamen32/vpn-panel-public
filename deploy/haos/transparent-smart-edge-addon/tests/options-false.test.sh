#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

fixture="$workdir/options-false.json"
printf "%s\n" '{"lan_us_proxy_enabled":false,"lan_de_proxy_enabled":false}' >"$fixture"
OPTIONS_PATH="$fixture"
# shellcheck source=/dev/null
source "$root/rootfs/usr/lib/transparent-smart-edge-options.sh"

[[ "$(option lan_us_proxy_enabled true)" == false ]]
[[ "$(option lan_de_proxy_enabled true)" == false ]]
[[ "$(option missing_option true)" == true ]]

printf "options false preservation: ok\n"
