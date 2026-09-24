"""AVIF encoding via avifenc."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from .media import ImageDecoder, MediaError, TemporaryWorkspace
from .models import EncodeSettings, ProbeResult
from .process import CommandRunner
from .toolchain import Toolchain


class EncodeError(RuntimeError):
    pass


class AvifEncoder:
    def __init__(
        self,
        toolchain: Toolchain,
        settings: EncodeSettings,
        runner: Optional[CommandRunner] = None,
        decoder: Optional[ImageDecoder] = None,
        threads: int = 1,
    ) -> None:
        self._tools = toolchain
        self._settings = settings
        self._runner = runner or CommandRunner()
        self._decoder = decoder or ImageDecoder(toolchain, self._runner)
        self._threads = max(1, threads)

    def encode(self, probe: ProbeResult, output: Path) -> None:
        output.parent.mkdir(parents=True, exist_ok=True)
        with TemporaryWorkspace("avifenc_in_") as tmpdir:
            try:
                enc_input, with_alpha = self._decoder.rasterize_for_encoder(
                    Path(probe.path), probe.kind, tmpdir
                )
            except MediaError as exc:
                raise EncodeError(str(exc)) from exc

            speed = self._settings.speed
            # SVT-AV1 requires preset M5 or faster for 8K / high-resolution images (>~20MP).
            if self._settings.codec == "svt" and (
                probe.width >= 4096
                or probe.height >= 4096
                or (probe.width > 0 and probe.height > 0 and probe.width * probe.height >= 8_000_000)
            ):
                speed = max(speed, 5)

            cmd = self._build_command(
                enc_input,
                output,
                speed=speed,
                with_alpha=with_alpha,
                with_gain_map=probe.has_gain_map,
                has_icc=probe.has_icc,
            )
            proc = self._runner.run(cmd)

            # Auto-retry with preset 5 if SVT-AV1 reports 8k+ preset limit
            if proc.returncode != 0 and self._settings.codec == "svt" and speed < 5:
                err_text = ((proc.stderr or "") + (proc.stdout or "")).lower()
                if "8k+ resolution support is limited to m5" in err_text:
                    speed = 5
                    cmd = self._build_command(
                        enc_input,
                        output,
                        speed=speed,
                        with_alpha=with_alpha,
                        with_gain_map=probe.has_gain_map,
                        has_icc=probe.has_icc,
                    )
                    proc = self._runner.run(cmd)

            if proc.returncode != 0 or not output.is_file():
                if output.exists():
                    output.unlink(missing_ok=True)
                raise EncodeError(self._extract_error(proc))

    @staticmethod
    def _extract_error(proc) -> str:
        err = (proc.stderr or "").strip()
        if err:
            lines = [line.strip() for line in err.splitlines() if line.strip()]
            for line in reversed(lines):
                if any(term in line.lower() for term in ("error", "failed", "svt[error]", "fatal")):
                    return line
            return lines[-1]
        out = (proc.stdout or "").strip()
        if out:
            lines = [line.strip() for line in out.splitlines() if line.strip()]
            for line in reversed(lines):
                if any(term in line.lower() for term in ("error", "failed", "svt[error]", "fatal")):
                    return line
            return lines[-1]
        return "avifenc failed"

    def _build_command(
        self,
        input_path: Path,
        output: Path,
        *,
        speed: int,
        with_alpha: bool,
        with_gain_map: bool,
        has_icc: bool = False,
    ) -> list[str]:
        cmd = [
            self._tools.avifenc,
            "--codec",
            self._settings.codec,
            # Force 4:2:0 subsampling to save memory and ensure compatibility
            "--yuv",
            "420",
            "-q",
            str(self._settings.quality),
            "-s",
            str(speed),
            "-j",
            str(self._threads),
        ]
        if not has_icc:
            # Use BT.709 matrix (CICP 1/13/1) for standard sRGB images to prevent
            # green-tint shifts on viewers that assume BT.709 matrix coefficients
            # instead of JPEG's default BT.601 (matrix 6).
            cmd.extend(["--cicp", "1/13/1"])
        if with_alpha:
            cmd.extend(["--qalpha", str(self._settings.quality)])
        if with_gain_map and self._tools.has_qgain_map:
            cmd.extend(["--qgain-map", str(self._settings.gain_quality)])
        cmd.extend(["--no-overwrite", str(input_path), str(output)])
        return cmd
