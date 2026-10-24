"""Video encoding execution via ffmpeg + libsvtav1."""

from __future__ import annotations

import subprocess
import time
from pathlib import Path

from .constants import MP4_COMPATIBLE_AUDIO_CODECS
from .models import EncodeSettings, VideoInfo
from .toolchain import Toolchain


class EncodeError(RuntimeError):
    pass


def compute_adaptive_video_crf(info: VideoInfo, base_crf: int) -> tuple[int, str]:
    """Compute optimal AV1 CRF dynamically based on resolution, bitrate, and dynamic range.

    Prevents quality degradation on already-compressed or low-resolution videos,
    and maximizes compression efficiency on high-bitrate 4K camera originals.
    """
    reasons: list[str] = []
    crf = base_crf

    # 1. Resolution-based scaling
    pixels = info.width * info.height
    if pixels >= 3840 * 2160:  # 4K UHD
        crf = min(crf + 2, 32)
        reasons.append("4K high-density (+2 CRF)")
    elif pixels >= 2560 * 1440:  # 1440p
        crf = min(crf + 1, 31)
        reasons.append("1440p density (+1 CRF)")
    elif 0 < pixels <= 1280 * 720:  # 720p or lower
        crf = max(crf - 2, 22)
        reasons.append("<=720p low-res detail preservation (-2 CRF)")

    # 2. Bitrate / BPPF (bits per pixel-frame) estimation
    if info.duration > 0 and pixels > 0 and info.fps > 0 and info.size_bytes > 0:
        bppf = (info.size_bytes * 8.0) / (pixels * info.fps * info.duration)
        reasons.append(f"BPPF={bppf:.3f}")
        if bppf < 0.05:  # Pre-compressed low-bitrate video
            crf = max(crf - 2, 22)
            reasons.append("low-bitrate source safeguard (-2 CRF)")

    # 3. HDR 10-bit color gradient protection
    if info.is_hdr or info.bit_depth > 8:
        if crf > 26:
            crf = 26
            reasons.append("10-bit HDR banding prevention (capped at 26)")

    return crf, ", ".join(reasons) or "default"


class VideoEncoder:
    def __init__(self, toolchain: Toolchain, settings: EncodeSettings) -> None:
        self._tools = toolchain
        self._settings = settings

    def build_ffmpeg_cmd(self, info: VideoInfo, output_path: Path) -> list[str]:
        target_crf = self._settings.crf
        if self._settings.adaptive_quality:
            target_crf, reason = compute_adaptive_video_crf(info, self._settings.crf)
            print(f"  [Adaptive Quality] Using CRF {target_crf} (base: {self._settings.crf}, {reason})", flush=True)

        cmd = [
            self._tools.ffmpeg_bin,
            "-y",
            "-v", "warning",
            "-stats",
            "-i", info.path,
            "-map", "0:v:0",
            "-map", "0:a?",
            "-map", "0:s?",
            "-c:v", "libsvtav1",
            "-preset", str(self._settings.preset),
            "-crf", str(target_crf),
        ]

        # Configure SVT-AV1 params (RAM-safe threads / level of parallelism)
        threads = max(1, self._settings.threads)
        base_params = f"{self._settings.svt_params}:lp={threads}"
        cmd.extend(["-svtav1-params", base_params])

        # Color & Bit Depth
        if info.bit_depth > 8 or info.is_hdr:
            cmd.extend(["-pix_fmt", "yuv420p10le"])
            if info.color_primaries:
                cmd.extend(["-color_primaries", info.color_primaries])
            if info.color_transfer:
                cmd.extend(["-color_trc", info.color_transfer])
            if info.color_space:
                cmd.extend(["-colorspace", info.color_space])
        else:
            cmd.extend(["-pix_fmt", "yuv420p"])

        # Audio stream handling
        if info.audio_codec:
            if self._settings.audio_codec == "auto":
                if info.audio_codec.lower() in MP4_COMPATIBLE_AUDIO_CODECS:
                    cmd.extend(["-c:a", "copy"])
                else:
                    cmd.extend(["-c:a", "aac", "-b:a", self._settings.audio_bitrate])
            else:
                cmd.extend(["-c:a", self._settings.audio_codec])
                if self._settings.audio_codec != "copy":
                    cmd.extend(["-b:a", self._settings.audio_bitrate])

        # Subtitle handling (mov_text is the standard for MP4 containers)
        cmd.extend(["-c:s", "mov_text"])

        # Container streaming flags
        if self._settings.faststart:
            cmd.extend(["-movflags", "+faststart"])

        cmd.append(str(output_path))
        return cmd

    def encode(self, info: VideoInfo, output_path: Path) -> float:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        cmd = self.build_ffmpeg_cmd(info, output_path)

        start_time = time.time()
        try:
            res = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=False,
            )
        except Exception as e:
            raise EncodeError(f"Failed to spawn ffmpeg: {e}") from e

        elapsed = time.time() - start_time

        if res.returncode != 0:
            err_msg = res.stderr.strip() or res.stdout.strip()
            raise EncodeError(f"FFmpeg encoding failed (exit code {res.returncode}): {err_msg}")

        if not output_path.exists() or output_path.stat().st_size == 0:
            raise EncodeError("FFmpeg finished but output file is missing or empty")

        return elapsed
