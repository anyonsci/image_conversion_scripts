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


def compute_adaptive_video_crf(info: VideoInfo, base_crf: int = 30) -> tuple[int, str]:
    """Compute optimal AV1 CRF dynamically (30-36) based on resolution, framerate, bitrate, and dynamic range.

    Guarantees that high-bitrate smartphone camera footage, 4K UHD, and 60 FPS video
    compress effectively without size bloat, while preserving visual transparency and smooth gradients.
    Dynamic range is strictly constrained to [30, 36].
    """
    reasons: list[str] = []

    # Start at base CRF (clamped within [30, 36], default 30)
    crf = max(30, min(base_crf, 36))

    # 1. Resolution-based scaling
    pixels = info.width * info.height
    if pixels >= 3840 * 2160:  # 4K UHD
        crf += 4
        reasons.append("4K high-density (+4 CRF)")
    elif pixels >= 2560 * 1440:  # 1440p
        crf += 2
        reasons.append("1440p density (+2 CRF)")
    elif pixels >= 1920 * 1080:  # 1080p Full HD
        crf += 1
        reasons.append("1080p Full HD (+1 CRF)")
    else:
        reasons.append("<=720p detail preservation (base CRF)")

    # 2. High Framerate (FPS >= 50, e.g. 60 FPS)
    # Temporal integration in human vision masks micro-quantization;
    # +1 CRF prevents 60fps from inflating overall bitrate
    if info.fps >= 50.0:
        crf += 1
        reasons.append(f"{info.fps:.0f}fps temporal masking (+1 CRF)")

    # 3. Short Micro-Clip Overhead Compensation (duration <= 5.0s)
    # In clips <= 5s, initial I-frame and container overhead take a disproportionate share
    if 0 < info.duration <= 5.0 and pixels >= 1920 * 1080:
        crf += 1
        reasons.append("micro-clip I-frame overhead compensation (+1 CRF)")

    # 4. Input Codec Efficiency Check
    # HEVC/H.265 is already ~40-50% more efficient than H.264.
    # When source is HEVC, +1 CRF is needed to out-compress the high-efficiency source
    if info.video_codec.lower() in ("hevc", "h265", "hev1", "hvc1"):
        crf += 1
        reasons.append("HEVC source efficiency (+1 CRF)")

    # 5. Bitrate / BPPF (bits per pixel-frame) scaling
    if info.duration > 0 and pixels > 0 and info.fps > 0 and info.size_bytes > 0:
        bppf = (info.size_bytes * 8.0) / (pixels * info.fps * info.duration)
        reasons.append(f"BPPF={bppf:.3f}")
        if pixels > 1280 * 720:
            if bppf >= 0.22:
                # High-bitrate phone camera original with sensor noise; scale up to avoid file bloat
                crf += 2
                reasons.append("high-bitrate camera original (+2 CRF)")
            elif bppf >= 0.12:
                crf += 1
                reasons.append("moderate-bitrate camera video (+1 CRF)")
            elif bppf < 0.05:
                # Already heavily compressed; floor at 30
                crf = max(30, crf - 1)
                reasons.append("low-bitrate source safeguard")

    # 6. HDR 10-bit banding safeguard
    # For <=1080p HDR, cap at 32 (or 33 if 60fps) to prevent banding on lower-density screens.
    # For 4K HDR, 10-bit density allows up to 36 with pristine gradients.
    if info.is_hdr or info.bit_depth > 8:
        if pixels < 3840 * 2160:
            max_hdr_crf = 33 if info.fps >= 50.0 else 32
            if crf > max_hdr_crf:
                crf = max_hdr_crf
                reasons.append(f"1080p 10-bit HDR gradient protection (capped at {max_hdr_crf})")

    # Strictly enforce 30-36 dynamic range
    final_crf = max(30, min(crf, 36))
    return final_crf, ", ".join(reasons) or "default"


class VideoEncoder:
    def __init__(self, toolchain: Toolchain, settings: EncodeSettings) -> None:
        self._tools = toolchain
        self._settings = settings

    def build_ffmpeg_cmd(self, info: VideoInfo, output_path: Path) -> list[str]:
        target_crf = self._settings.crf
        if self._settings.adaptive_quality:
            target_crf, reason = compute_adaptive_video_crf(info, self._settings.crf)
            print(f"  [Adaptive Quality] Using CRF {target_crf} (base: {self._settings.crf}, {reason})", flush=True)

        preset = self._settings.preset
        # 4K UHD throughput optimization: Preset 8 takes ~1.5h per 5s on low-core CPUs;
        # dynamically use Preset 10 for 4K to achieve 5x-8x throughput
        pixels = info.width * info.height
        if pixels >= 3840 * 2160 and preset < 10:
            preset = 10
            print(f"  [4K UHD Dynamic Preset] Using Preset {preset} for 4K video (accelerates encoding on multi-core CPU)", flush=True)

        if info.is_low_bitrate:
            preset = max(preset, 10)
            print(f"  [Low-Bitrate Fast-Pass] Source is pre-compressed ({info.bitrate_bps / 1000:.0f} kbps); using fast Preset {preset}", flush=True)

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
            "-preset", str(preset),
            "-crf", str(target_crf),
        ]

        # Configure SVT-AV1 params:
        # If threads > 0, restrict to specified thread count (RAM-safe for cloud instances).
        # If threads <= 0, use lp=0 to auto-scale across all available CPU cores.
        if self._settings.threads > 0:
            base_params = f"{self._settings.svt_params}:lp={self._settings.threads}"
        else:
            base_params = f"{self._settings.svt_params}:lp=0"

        # Capped CRF: Enforce maximum bitrate ceiling at 90% of source bitrate
        # Prevents negative compression / size bloat on noisy or complex high-entropy scenes
        if info.bitrate_bps > 0:
            mbr_kbps = max(300, int((info.bitrate_bps * 0.90) / 1000.0))
            base_params += f":mbr={mbr_kbps}"
            print(f"  [Capped CRF] Enforcing maximum bitrate ceiling mbr={mbr_kbps} kbps (90% of source {info.bitrate_bps / 1000:.0f} kbps)", flush=True)

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

        # Preserve all global metadata and original creation time
        cmd.extend(["-map_metadata", "0"])
        if info.creation_time:
            cmd.extend(["-metadata", f"creation_time={info.creation_time}"])

        # Subtitle handling (mov_text is the standard for MP4 containers)
        cmd.extend(["-c:s", "mov_text"])

        # Container streaming and full metadata tag preservation
        movflags = []
        if self._settings.faststart:
            movflags.append("+faststart")
        movflags.append("+use_metadata_tags")
        cmd.extend(["-movflags", "".join(movflags)])

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
