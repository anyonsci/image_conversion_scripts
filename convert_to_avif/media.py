"""Raster decode / PNG helpers shared by encoding and QA."""

from __future__ import annotations

import struct
import tempfile
from pathlib import Path
from typing import Optional

from .models import ImageKind
from .process import CommandRunner
from .probing import ImageProber
from .toolchain import Toolchain


class MediaError(RuntimeError):
    pass


class ImageDecoder:
    """Decode stills to PNG for comparison or encoder preprocessing."""

    def __init__(self, toolchain: Toolchain, runner: Optional[CommandRunner] = None) -> None:
        self._tools = toolchain
        self._runner = runner or CommandRunner()

    def to_png(self, src: Path, dst_png: Path) -> None:
        kind = ImageProber.detect_kind(src)
        if kind is ImageKind.UNKNOWN and src.suffix.lower() == ".avif":
            kind = ImageKind.AVIF

        if kind is ImageKind.AVIF:
            self._decode_avif(src, dst_png)
            return
        if self._tools.ffmpeg:
            self._ffmpeg_still(src, dst_png)
            return
        self._pillow_still(src, dst_png)

    def rasterize_for_encoder(self, src: Path, kind: ImageKind, tmpdir: Path) -> tuple[Path, bool]:
        """Return (path suitable for avifenc, with_alpha)."""
        if kind is ImageKind.WEBP:
            if not self._tools.ffmpeg:
                raise MediaError("webp input requires ffmpeg on PATH to rasterize to PNG")
            png = tmpdir / f"{src.stem}.png"
            self._ffmpeg_still(src, png)
            return png, True
        return src, kind is ImageKind.PNG

    def _decode_avif(self, src: Path, dst_png: Path) -> None:
        if not self._tools.avifdec:
            raise MediaError("avifdec is required to decode AVIF")
        proc = self._runner.run([self._tools.avifdec, str(src), str(dst_png)])
        if proc.returncode != 0 or not dst_png.is_file():
            raise MediaError("avifdec failed")

    def _ffmpeg_still(self, src: Path, dst_png: Path) -> None:
        assert self._tools.ffmpeg
        proc = self._runner.run(
            [
                self._tools.ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(src),
                "-frames:v",
                "1",
                str(dst_png),
            ]
        )
        if proc.returncode != 0 or not dst_png.is_file():
            raise MediaError(f"ffmpeg failed to decode {src}")

    @staticmethod
    def _pillow_still(src: Path, dst_png: Path) -> None:
        try:
            from PIL import Image  # type: ignore
        except ImportError as exc:
            raise MediaError("no decoder available (install ffmpeg or Pillow)") from exc
        try:
            with Image.open(src) as im:
                im.convert("RGB").save(dst_png, format="PNG")
        except Exception as exc:  # noqa: BLE001 - surface as MediaError
            raise MediaError(f"Pillow failed to decode {src}") from exc
        if not dst_png.is_file():
            raise MediaError(f"Pillow produced no output for {src}")


class PngInfo:
    @staticmethod
    def dimensions(path: Path) -> tuple[int, int]:
        with path.open("rb") as handle:
            if handle.read(8) != b"\x89PNG\r\n\x1a\n":
                return 0, 0
            handle.read(4)
            if handle.read(4) != b"IHDR":
                return 0, 0
            width, height = struct.unpack(">II", handle.read(8))
            return int(width), int(height)


class TemporaryWorkspace:
    """Context manager alias kept for readability at call sites."""

    def __init__(self, prefix: str) -> None:
        self._cm = tempfile.TemporaryDirectory(prefix=prefix)

    def __enter__(self) -> Path:
        return Path(self._cm.__enter__())

    def __exit__(self, *args: object) -> None:
        self._cm.__exit__(*args)
