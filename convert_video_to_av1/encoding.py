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

        log_path = Path(self._settings.log_file).resolve() if self._settings.log_file else None
        start_time = time.time()
        start_ts = time.strftime("%Y-%m-%d %H:%M:%S")

        if log_path:
            log_path.parent.mkdir(parents=True, exist_ok=True)
            with open(log_path, "a", encoding="utf-8") as f:
                f.write(f"\n{'='*70}\n")
                f.write(f"[{start_ts}] Encoding: {info.path}\n")
                f.write(f"Output: {output_path}\n")
                f.write(f"Resolution: {info.width}x{info.height} | Duration: {info.duration:.2f}s | FPS: {info.fps}\n")
                f.write(f"FFmpeg Command: {' '.join(cmd)}\n")
                f.write(f"{'-'*70}\n")
                f.flush()

        try:
            if log_path:
                with open(log_path, "a", encoding="utf-8") as f:
                    res = subprocess.run(
                        cmd,
                        stdout=f,
                        stderr=subprocess.STDOUT,
                        text=True,
                        check=False,
                    )
            else:
                res = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    check=False,
                )
        except Exception as e:
            raise EncodeError(f"Failed to spawn ffmpeg: {e}") from e

        elapsed = time.time() - start_time
        end_ts = time.strftime("%Y-%m-%d %H:%M:%S")

        if log_path:
            with open(log_path, "a", encoding="utf-8") as f:
                status_str = "SUCCESS" if res.returncode == 0 else f"FAILED (exit code {res.returncode})"
                f.write(f"\n[{end_ts}] Status: {status_str} | Elapsed: {elapsed:.2f}s\n")
                f.write(f"{'='*70}\n")
                f.flush()

        if res.returncode != 0:
            tail_lines = ""
            if log_path and log_path.exists():
                try:
                    with open(log_path, "r", encoding="utf-8", errors="replace") as f:
                        tail_lines = "".join(f.readlines()[-20:]).strip()
                except Exception:
                    pass
            err_msg = tail_lines or (res.stderr.strip() if hasattr(res, "stderr") and res.stderr else "Unknown error")
            raise EncodeError(f"FFmpeg encoding failed (exit code {res.returncode}):\n{err_msg}")

        if not output_path.exists() or output_path.stat().st_size == 0:
            raise EncodeError("FFmpeg finished but output file is missing or empty")

        return elapsed
