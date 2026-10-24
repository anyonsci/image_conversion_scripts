"""Toolchain detection and capability verification."""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from typing import Optional

from .constants import INSTALL_HINT


class ToolchainError(RuntimeError):
    pass


@dataclass(frozen=True)
class Toolchain:
    ffmpeg_bin: str
    ffprobe_bin: str
    has_libsvtav1: bool
    exiftool_bin: Optional[str] = None

    @classmethod
    def detect(cls) -> "Toolchain":
        ffmpeg_bin = os.getenv("FFMPEG") or shutil.which("ffmpeg")
        ffprobe_bin = os.getenv("FFPROBE") or shutil.which("ffprobe")
        exiftool_bin = os.getenv("EXIFTOOL") or shutil.which("exiftool")

        missing = []
        if not ffmpeg_bin:
            missing.append("ffmpeg")
        if not ffprobe_bin:
            missing.append("ffprobe")

        if missing:
            raise ToolchainError(
                f"Missing required tool(s): {', '.join(missing)}\n\n{INSTALL_HINT}"
            )

        # Check for libsvtav1 encoder
        try:
            res = subprocess.run(
                [ffmpeg_bin, "-encoders"],
                capture_output=True,
                text=True,
                check=True,
            )
            has_svt = "libsvtav1" in res.stdout
        except Exception as e:
            raise ToolchainError(f"Failed to query ffmpeg encoders: {e}")

        if not has_svt:
            raise ToolchainError(
                f"ffmpeg at '{ffmpeg_bin}' does not support 'libsvtav1' encoder.\n\n{INSTALL_HINT}"
            )

        return cls(
            ffmpeg_bin=ffmpeg_bin,
            ffprobe_bin=ffprobe_bin,
            has_libsvtav1=True,
            exiftool_bin=exiftool_bin,
        )
