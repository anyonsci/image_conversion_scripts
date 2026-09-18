"""External tool discovery and capability detection."""

from __future__ import annotations

import base64
import os
import re
import shutil
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional

from .constants import INSTALL_HINT, PROBE_JPEG_B64
from .process import CommandRunner


class ToolchainError(RuntimeError):
    """Required tools missing or unusable."""

    def __init__(self, message: str) -> None:
        super().__init__(f"{message}\n\n{INSTALL_HINT}")


@dataclass(frozen=True)
class Toolchain:
    avifenc: str
    avifdec: Optional[str] = None
    avifgainmaputil: Optional[str] = None
    exiftool: Optional[str] = None
    dssim: Optional[str] = None
    ffmpeg: Optional[str] = None
    has_qgain_map: bool = False
    has_tonemap: bool = False
    has_encoder: bool = False
    encoder_note: str = ""

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "Toolchain":
        return cls(**data)

    def report_lines(self) -> list[str]:
        gain = (
            "yes"
            if self.has_qgain_map
            else "NO (SDR-only; rebuild libavif with gain maps)"
        )
        return [
            f"avifenc:          {self.avifenc}",
            f"  encoder:        {self.encoder_note or ('yes' if self.has_encoder else 'NO')}",
            f"  gain-map flag:  {gain}",
            f"avifdec:          {self.avifdec or 'missing (Tier A decode checks limited)'}",
            f"avifgainmaputil:  {self.avifgainmaputil or 'missing (gain-map verify limited)'}",
            f"exiftool:         {self.exiftool or 'missing (metadata checks limited)'}",
            f"dssim:            {self.dssim or 'missing'}",
            f"ffmpeg:           {self.ffmpeg or 'missing'}",
        ]


class ToolchainFactory:
    """Resolve binaries from PATH / env overrides and validate SVT encode capability."""

    def __init__(self, runner: Optional[CommandRunner] = None) -> None:
        self._runner = runner or CommandRunner()

    def discover(self) -> Toolchain:
        avifenc = self._which("AVIFENC", "avifenc")
        if not avifenc:
            raise ToolchainError("ERROR: avifenc not found.")

        has_qgain = self._supports_qgain_map(avifenc)
        has_encoder, encoder_note = self._probe_encoder(avifenc)
        if not has_encoder:
            raise ToolchainError(f"ERROR: avifenc cannot encode ({encoder_note}).")

        gainutil = self._which("AVIFGAINMAPUTIL", "avifgainmaputil")
        has_tonemap = False
        if gainutil:
            has_tonemap = "tonemap" in self._runner.output([gainutil])

        return Toolchain(
            avifenc=avifenc,
            avifdec=self._which("AVIFDEC", "avifdec"),
            avifgainmaputil=gainutil,
            exiftool=self._which("EXIFTOOL", "exiftool"),
            dssim=self._which("DSSIM", "dssim"),
            ffmpeg=self._which("FFMPEG", "ffmpeg"),
            has_qgain_map=has_qgain,
            has_tonemap=has_tonemap,
            has_encoder=has_encoder,
            encoder_note=encoder_note,
        )

    @staticmethod
    def _which(env_key: str, name: str) -> Optional[str]:
        override = os.environ.get(env_key)
        if override:
            path = Path(override)
            if path.is_file() and os.access(path, os.X_OK):
                return str(path.resolve())
            return None
        return shutil.which(name)

    def _supports_qgain_map(self, avifenc: str) -> bool:
        combined = self._runner.output([avifenc, "-h"]) + self._runner.output([avifenc, "-V"])
        if "--qgain-map" in combined:
            return True
        probe = self._runner.run([avifenc, "--qgain-map", "85", "-h"])
        return probe.returncode == 0 or "--qgain-map" in ((probe.stdout or "") + (probe.stderr or ""))

    def _probe_encoder(self, avifenc: str) -> tuple[bool, str]:
        with tempfile.TemporaryDirectory(prefix="avifenc_probe_") as td:
            jpg = Path(td) / "t.jpg"
            avif = Path(td) / "t.avif"
            jpg.write_bytes(base64.b64decode(PROBE_JPEG_B64))
            proc = self._runner.run(
                [
                    avifenc,
                    "--codec",
                    "svt",
                    "-q",
                    "60",
                    "-s",
                    "10",
                    "-j",
                    "1",
                    str(jpg),
                    str(avif),
                ]
            )
            out = ((proc.stdout or "") + (proc.stderr or "")).lower()
            if proc.returncode == 0 and avif.is_file() and avif.stat().st_size > 0:
                return True, "svt"
            if (
                "no codec available" in out
                or "codec 'none'" in out
                or not re.search(r"\bsvt\b", self._runner.output([avifenc, "--version"]).lower())
            ):
                return False, "SVT-AV1 is not linked into libavif (enable AVIF_CODEC_SVT)"
            lines = ((proc.stderr or "") + (proc.stdout or "") or "encode probe failed").strip().splitlines()
            return False, (lines[-1] if lines else "encode probe failed")[:200]
