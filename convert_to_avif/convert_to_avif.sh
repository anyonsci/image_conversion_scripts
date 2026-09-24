#!/usr/bin/env bash
# Thin wrapper around the convert_to_avif package
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARENT="$(dirname "$ROOT")"
export PYTHONPATH="${PARENT}${PYTHONPATH:+:$PYTHONPATH}"
export PYTHONUNBUFFERED=1
exec python3 -u -m convert_to_avif "$@"
