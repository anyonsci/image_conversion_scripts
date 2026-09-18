#!/usr/bin/env bash
# Thin wrapper around the convert_to_avif package
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARENT="$(dirname "$ROOT")"
export PYTHONPATH="${PARENT}${PYTHONPATH:+:$PYTHONPATH}"
exec python3 -m convert_to_avif "$@"
