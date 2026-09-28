"""AVIF encoding via avifenc."""

from __future__ import annotations

import math
from pathlib import Path
from typing import Optional

from .media import ImageDecoder, MediaError, TemporaryWorkspace
from .models import EncodeSettings, ImageKind, ProbeResult
from .process import CommandRunner
from .toolchain import Toolchain


class EncodeError(RuntimeError):
    pass


def compute_android_compatible_grid(
    width: int,
    height: int,
    max_pixels: int = 8_912_896,
    max_dim: int = 4096,
) -> Optional[tuple[int, int]]:
    """Compute optimal (cols, rows) grid to keep each cell within MIAF Baseline Level <= 5.1

    (<= 8,912,896 pixels and max dimension <= 4096) for Android compatibility.
    """
    if width <= 0 or height <= 0:
        return None
    if width * height <= max_pixels and width <= max_dim and height <= max_dim:
        return None

    cols = max(1, math.ceil(width / max_dim))
    rows = max(1, math.ceil(height / max_dim))
    while (width / cols) * (height / rows) > max_pixels or (width / cols) > max_dim or (height / rows) > max_dim:
        if (width / cols) >= (height / rows):
            cols += 1
        else:
            rows += 1
    return cols, rows


def compute_adaptive_quality(probe: ProbeResult, base_quality: int) -> tuple[int, str]:
    """Compute optimal AVIF quality based on source format, estimated JPEG quality, and BPP.

    Prevents file size inflation when transcoding pre-compressed lossy JPEGs
    while preserving high visual fidelity for clean/camera originals.
    """
    if probe.kind != ImageKind.JPEG:
        return base_quality, f"lossless/non-jpeg source, using base quality {base_quality}"

    q_src = probe.estimated_quality
    bpp = probe.bpp

    reason_parts: list[str] = []
    if q_src is not None:
        reason_parts.append(f"src Q~{q_src}")
        if q_src >= 92:
            target_q = min(base_quality, 76)
        elif q_src >= 86:
            target_q = min(base_quality, 73)
        elif q_src >= 78:
            target_q = min(base_quality, 70)
        elif q_src >= 70:
            target_q = min(base_quality, 67)
        else:
            target_q = min(base_quality, 64)
    else:
        reason_parts.append("src Q unknown")
        if bpp >= 2.0:
            target_q = min(base_quality, 76)
        elif bpp >= 1.2:
            target_q = min(base_quality, 73)
        elif bpp >= 0.8:
            target_q = min(base_quality, 70)
        else:
            target_q = min(base_quality, 66)

    if bpp > 0:
        reason_parts.append(f"BPP={bpp:.2f}")
        # Entropy safety cap to prevent bloat on noisy or heavily compressed files
        if bpp < 0.6:
            target_q = min(target_q, 68)
        elif bpp < 1.0:
            target_q = min(target_q, 72)

    final_q = max(55, min(base_quality, target_q))
    return final_q, ", ".join(reason_parts)


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

    def encode(self, probe: ProbeResult, output: Path) -> tuple[int, str]:
        output.parent.mkdir(parents=True, exist_ok=True)
        with TemporaryWorkspace("avifenc_in_") as tmpdir:
            try:
                enc_input, with_alpha = self._decoder.rasterize_for_encoder(
                    Path(probe.path), probe.kind, tmpdir
                )
            except MediaError as exc:
                raise EncodeError(str(exc)) from exc

            width = probe.width
            height = probe.height
            if (width == 0 or height == 0) and Path(probe.path).is_file():
                try:
                    from PIL import Image

                    with Image.open(probe.path) as im:
                        width, height = im.size
                except Exception:
                    pass

            grid = self._settings.grid
            if grid is None and self._settings.android_compatible and not probe.has_gain_map:
                grid = compute_android_compatible_grid(width, height)

            # MIAF YUV420 requires grid image width, height, and cell dimensions to be even numbers
            if grid is not None and width > 0 and height > 0:
                if width % 2 != 0 or height % 2 != 0:
                    even_w = width - (width % 2)
                    even_h = height - (height % 2)
                    even_file = tmpdir / f"even_{enc_input.name}"
                    cropped = False
                    try:
                        from PIL import Image

                        with Image.open(enc_input) as im:
                            im.crop((0, 0, even_w, even_h)).save(even_file)
                            cropped = True
                    except Exception:
                        if self._tools.ffmpeg:
                            proc_crop = self._runner.run(
                                [
                                    self._tools.ffmpeg,
                                    "-hide_banner",
                                    "-loglevel",
                                    "error",
                                    "-y",
                                    "-i",
                                    str(enc_input),
                                    "-vf",
                                    f"crop={even_w}:{even_h}:0:0",
                                    str(even_file),
                                ]
                            )
                            cropped = proc_crop.returncode == 0 and even_file.is_file()
                    if cropped and even_file.is_file():
                        enc_input = even_file

            speed = self._settings.speed
            # SVT-AV1 requires preset M5 or faster for 8K / high-resolution images (>~20MP).
            if self._settings.codec == "svt" and (
                probe.width >= 4096
                or probe.height >= 4096
                or (probe.width > 0 and probe.height > 0 and probe.width * probe.height >= 8_000_000)
            ):
                speed = max(speed, 5)

            if self._settings.adaptive_quality:
                quality, reason = compute_adaptive_quality(probe, self._settings.quality)
                gain_quality = min(quality, self._settings.gain_quality)
            else:
                quality = self._settings.quality
                reason = "fixed"
                gain_quality = self._settings.gain_quality

            cmd = self._build_command(
                enc_input,
                output,
                speed=speed,
                quality=quality,
                gain_quality=gain_quality,
                with_alpha=with_alpha,
                with_gain_map=probe.has_gain_map,
                has_icc=probe.has_icc,
                grid=grid,
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
                        quality=quality,
                        gain_quality=gain_quality,
                        with_alpha=with_alpha,
                        with_gain_map=probe.has_gain_map,
                        has_icc=probe.has_icc,
                        grid=grid,
                    )
                    proc = self._runner.run(cmd)

            if proc.returncode != 0 or not output.is_file():
                if output.exists():
                    output.unlink(missing_ok=True)
                raise EncodeError(self._extract_error(proc))

            # Restore original metadata if grid encoding or rasterized intermediate (HEIC, WEBP) was used
            if (grid is not None or enc_input != Path(probe.path)) and self._tools.exiftool and Path(probe.path).is_file():
                self._runner.run(
                    [
                        self._tools.exiftool,
                        "-tagsFromFile",
                        str(probe.path),
                        "-overwrite_original",
                        str(output),
                    ]
                )

            return quality, reason

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
        quality: int,
        gain_quality: int,
        with_alpha: bool,
        with_gain_map: bool,
        has_icc: bool = False,
        grid: Optional[tuple[int, int]] = None,
    ) -> list[str]:
        cmd = [
            self._tools.avifenc,
            "--codec",
            self._settings.codec,
            # Force 4:2:0 subsampling to save memory and ensure compatibility
            "--yuv",
            "420",
            "-q",
            str(quality),
            "-s",
            str(speed),
            "-j",
            str(self._threads),
        ]
        if grid is not None:
            cmd.extend(["-g", f"{grid[0]}x{grid[1]}"])
        if not has_icc:
            # Use BT.709 matrix (CICP 1/13/1) for standard sRGB images to prevent
            # green-tint shifts on viewers that assume BT.709 matrix coefficients
            # instead of JPEG's default BT.601 (matrix 6).
            cmd.extend(["--cicp", "1/13/1"])
        if with_alpha:
            cmd.extend(["--qalpha", str(quality)])
        if with_gain_map and self._tools.has_qgain_map:
            cmd.extend(["--qgain-map", str(gain_quality)])
        cmd.extend(["--no-overwrite", str(input_path), str(output)])
        return cmd
