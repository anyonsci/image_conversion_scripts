#!/usr/bin/env bash
# Thin wrapper around the convert_video_to_av1 Python package
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARENT="$(dirname "$ROOT")"
export PYTHONPATH="${PARENT}${PYTHONPATH:+:$PYTHONPATH}"
export PYTHONUNBUFFERED=1
exec python3 -u -m convert_video_to_av1 "$@"
