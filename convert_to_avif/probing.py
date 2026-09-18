"""Image probing: type, dimensions, metadata, gain maps."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

from .constants import (
    EXIF_HINT_KEYS,
    GAINMAP_MARKERS,
    GAINMAP_META_HINTS,
    ICC_HINT_KEYS,
)
from .models import ImageKind, ProbeResult
from .process import CommandRunner
from .toolchain import Toolchain


class MetadataReader:
    """Optional exiftool-backed metadata access."""

    def __init__(self, toolchain: Toolchain, runner: Optional[CommandRunner] = None) -> None:
        self._toolchain = toolchain
        self._runner = runner or CommandRunner()

    def read(self, path: Path) -> dict[str, Any]:
        if not self._toolchain.exiftool:
            return {}
        proc = self._runner.run([self._toolchain.exiftool, "-json", "-n", str(path)])
        if proc.returncode != 0 or not (proc.stdout or "").strip():
            return {}
        try:
            rows = json.loads(proc.stdout)
        except json.JSONDecodeError:
            return {}
        return rows[0] if rows else {}

    @staticmethod
    def has_any(meta: dict[str, Any], keys: tuple[str, ...]) -> bool:
        return any(meta.get(key) for key in keys)

    @staticmethod
    def blob_contains(meta: dict[str, Any], needles: tuple[str, ...]) -> bool:
        blob = json.dumps(meta)
        return any(needle in blob for needle in needles)


class ImageProber:
    """Classify an image and extract archival-relevant attributes."""

    def __init__(self, toolchain: Toolchain, runner: Optional[CommandRunner] = None) -> None:
        self._meta = MetadataReader(toolchain, runner)

    def probe(self, path: Path) -> ProbeResult:
        kind = self.detect_kind(path)
        meta = self._meta.read(path)
        width = int(meta.get("ImageWidth") or meta.get("ExifImageWidth") or 0)
        height = int(meta.get("ImageHeight") or meta.get("ExifImageHeight") or 0)
        has_gain_map = False
        if kind is ImageKind.JPEG:
            has_gain_map = self._jpeg_has_gain_map(path) or self._meta.blob_contains(
                meta, GAINMAP_META_HINTS
            )
        return ProbeResult(
            path=str(path),
            kind=kind,
            has_gain_map=has_gain_map,
            has_exif=self._meta.has_any(meta, EXIF_HINT_KEYS),
            has_icc=self._meta.has_any(meta, ICC_HINT_KEYS),
            width=width,
            height=height,
            size_bytes=path.stat().st_size,
        )

    @staticmethod
    def detect_kind(path: Path) -> ImageKind:
        try:
            with path.open("rb") as handle:
                header = handle.read(16)
        except OSError:
            return ImageKind.UNKNOWN

        if header.startswith(b"\xff\xd8\xff"):
            return ImageKind.JPEG
        if header.startswith(b"\x89PNG\r\n\x1a\n"):
            return ImageKind.PNG
        if header[0:4] == b"RIFF" and header[8:12] == b"WEBP":
            return ImageKind.WEBP
        if path.suffix.lower() == ".avif":
            return ImageKind.AVIF

        ext = path.suffix.lower()
        return {
            ".jpg": ImageKind.JPEG,
            ".jpeg": ImageKind.JPEG,
            ".png": ImageKind.PNG,
            ".webp": ImageKind.WEBP,
            ".avif": ImageKind.AVIF,
        }.get(ext, ImageKind.UNKNOWN)

    @staticmethod
    def _jpeg_has_gain_map(path: Path) -> bool:
        try:
            data = path.read_bytes()
        except OSError:
            return False
        limit = 2 * 1024 * 1024
        scan = data if len(data) <= limit + 65536 else data[:limit] + data[-65536:]
        return any(marker in scan for marker in GAINMAP_MARKERS)
