"""Entrypoint for python3 -m convert_video_to_av1."""

import sys
from .cli import main

if __name__ == "__main__":
    sys.exit(main())
