"""External tool discovery and capability detection."""

from __future__ import annotations

import base64
import os
import re
import shutil
import signal
import sys
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional

from .constants import INSTALL_HINT, PROBE_IMAGE_B64
from .process import CommandRunner

DEBUG = os.environ.get("CONVERT_TO_AVIF_DEBUG", "").strip() not in ("", "0", "false", "no")


def _returncode_detail(code: int) -> str:
    if code < 0:
        try:
            name = signal.Signals(-code).name
        except ValueError:
            name = "UNKNOWN"
        return f"{code} (killed by signal {-code} {name})"
    return str(code)


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
        version = self._runner.output([avifenc, "--version"]).lower()
        available = [enc for enc in ("aom", "svt", "rav1e") if re.search(rf"\b{enc}\b", version)]
        if not available:
            return False, "no AV1 encoder linked into libavif"

        preferred = available[0]
        with tempfile.TemporaryDirectory(prefix="avifenc_probe_") as td:
            probe_image = Path(td) / "t.png"
            avif = Path(td) / "t.avif"
            probe_image.write_bytes(base64.b64decode(PROBE_IMAGE_B64))
            cmd = [
                avifenc,
                "--codec",
                preferred,
                "--yuv",
                "420",
                "-q",
                "60",
                "-s",
                "10" if preferred == "svt" else "8",
                "-j",
                "1",
                str(probe_image),
                str(avif),
            ]
            proc = self._runner.run(cmd)
            out_size = avif.stat().st_size if avif.is_file() else -1

            if DEBUG:
                self._dump_probe("probe", cmd, proc, out_size, version)

            if proc.returncode == 0 and out_size > 0:
                return True, ", ".join(available)

            self._dump_probe("PROBE FAILED", cmd, proc, out_size, version)
            lines = ((proc.stderr or "") + (proc.stdout or "") or "encode probe failed").strip().splitlines()
            return False, (lines[-1] if lines else "encode probe failed")[:200]

    @staticmethod
    def _dump_probe(label, cmd, proc, out_size, version) -> None:
        block = [
            "",
            f"===== avifenc {label} (SVT capability check) =====",
            f"cmd:        {' '.join(cmd)}",
            f"returncode: {_returncode_detail(proc.returncode)}",
            f"output avif size: {out_size} bytes",
            "--- avifenc --version ---",
            version.strip() or "(no output)",
            "--- probe stdout ---",
            (proc.stdout or "").rstrip() or "(empty)",
            "--- probe stderr ---",
            (proc.stderr or "").rstrip() or "(empty)",
            "==================================================",
            "",
        ]
        print("\n".join(block), file=sys.stderr)
