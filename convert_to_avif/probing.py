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


STD_LUM_QTABLE = (
    16, 11, 10, 16, 24, 40, 51, 61,
    12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56,
    14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77,
    24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101,
    72, 92, 95, 98, 112, 100, 103, 99,
)


def estimate_jpeg_quality(path: Path) -> Optional[int]:
    """Estimate JPEG quality factor (1-100) from DQT luminance quantization table."""
    try:
        from PIL import Image

        with Image.open(path) as im:
            if hasattr(im, "quantization") and im.quantization and 0 in im.quantization:
                qtable = im.quantization[0]
                diffs: list[float] = []
                for i in range(min(len(STD_LUM_QTABLE), len(qtable))):
                    if STD_LUM_QTABLE[i] > 0:
                        scale = (qtable[i] * 100.0) / STD_LUM_QTABLE[i]
                        if scale <= 100:
                            q = (200.0 - scale) / 2.0
                        else:
                            q = 5000.0 / scale
                        diffs.append(q)
                if diffs:
                    diffs.sort()
                    return max(1, min(100, round(diffs[len(diffs) // 2])))
    except Exception:
        pass
    return None


class ImageProber:
    """Classify an image and extract archival-relevant attributes."""

    def __init__(self, toolchain: Toolchain, runner: Optional[CommandRunner] = None) -> None:
        self._meta = MetadataReader(toolchain, runner)

    def probe(self, path: Path) -> ProbeResult:
        kind = self.detect_kind(path)
        meta = self._meta.read(path)
        width = int(meta.get("ImageWidth") or meta.get("ExifImageWidth") or 0)
        height = int(meta.get("ImageHeight") or meta.get("ExifImageHeight") or 0)
        if (width == 0 or height == 0) and path.is_file():
            try:
                from PIL import Image
                with Image.open(path) as im:
                    width, height = im.size
            except Exception:
                pass
        has_gain_map = False
        estimated_quality = None
        if kind is ImageKind.JPEG:
            has_gain_map = self._jpeg_has_gain_map(path) or self._meta.blob_contains(
                meta, GAINMAP_META_HINTS
            )
            estimated_quality = estimate_jpeg_quality(path)

        size_bytes = path.stat().st_size if path.is_file() else 0
        bpp = (size_bytes * 8.0) / (width * height) if (width > 0 and height > 0) else 0.0

        return ProbeResult(
            path=str(path),
            kind=kind,
            has_gain_map=has_gain_map,
            has_exif=self._meta.has_any(meta, EXIF_HINT_KEYS),
            has_icc=self._meta.has_any(meta, ICC_HINT_KEYS),
            width=width,
            height=height,
            size_bytes=size_bytes,
            estimated_quality=estimated_quality,
            bpp=bpp,
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
        if len(header) >= 12 and header[4:8] == b"ftyp" and any(
            header[8:12].startswith(b)
            for b in (b"heic", b"heix", b"hevc", b"heim", b"heis", b"mif1", b"msf1")
        ):
            return ImageKind.HEIC

        ext = path.suffix.lower()
        return {
            ".jpg": ImageKind.JPEG,
            ".jpeg": ImageKind.JPEG,
            ".png": ImageKind.PNG,
            ".webp": ImageKind.WEBP,
            ".avif": ImageKind.AVIF,
            ".heic": ImageKind.HEIC,
            ".heif": ImageKind.HEIC,
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
