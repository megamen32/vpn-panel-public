#!/usr/bin/env bash
# build-haos-addon-image.sh — build the Transparent Smart Edge add-on image from
# THIS repository and optionally emit a tarball for a foreign host.
#
# The add-on image used to be pulled prebuilt from a registry, which made every
# code change in this repo a silent no-op in production. This script is the
# supported way to produce that image, and it is deliberately runnable on any
# machine with Docker — not on the HAOS VM, which has too little RAM to compile
# sing-box without starving the live add-on's healthcheck.
#
# Usage:
#   scripts/build-haos-addon-image.sh                 # build + load locally
#   scripts/build-haos-addon-image.sh --save out.tgz  # build + write tarball
#
# The target platform is always linux/arm64: the HAOS VM is aarch64.
set -euo pipefail

platform="linux/arm64"
save_to=""
prefix="haos-smart-edge"
label="local/addon"

usage() {
    printf 'usage: %s [--save FILE]\n' "${0##*/}"
    exit 2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --save)
            [[ $# -ge 2 ]] || usage
            save_to="$2"
            shift 2
            ;;
        -h | --help) usage ;;
        *) printf 'unknown argument: %s\n' "$1" >&2; usage ;;
    esac
done

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
src="$root/deploy/haos/transparent-smart-edge-addon"

[[ -f "$src/Dockerfile" ]] || { printf 'no Dockerfile under %s\n' "$src" >&2; exit 1; }
[[ -f "$src/config.yaml" ]] || { printf 'no config.yaml under %s\n' "$src" >&2; exit 1; }

command -v docker >/dev/null || { printf 'docker is not installed\n' >&2; exit 1; }
docker info >/dev/null 2>&1 || { printf 'docker daemon is not reachable\n' >&2; exit 1; }

# The version is the add-on version, so the supervisor treats a new build as new.
version="$(sed -n 's/^version:[[:space:]]*"\{0,1\}\([^"]*\)"\{0,1\}[[:space:]]*$/\1/p' "$src/config.yaml" | head -1)"
[[ -n "$version" ]] || { printf 'could not read version from config.yaml\n' >&2; exit 1; }

image="$label/$prefix:$version"
printf 'building %s (%s) from %s\n' "$image" "$platform" "$src"

# --provenance=false keeps the export a single-platform image; attestation
# manifests make `docker load` on the destination host ambiguous.
docker buildx build \
    --platform "$platform" \
    --provenance=false \
    --load \
    -t "$image" \
    "$src"

if [[ -n "$save_to" ]]; then
    printf 'saving tarball to %s\n' "$save_to"
    tmp="$save_to.tmp"
    docker save "$image" | gzip -1 >"$tmp"
    mv -f "$tmp" "$save_to"
    printf 'done: %s\n' "$(ls -lh "$save_to" | awk '{print $5, $9}')"
    printf 'on the target host: docker load < %s\n' "$save_to"
fi
