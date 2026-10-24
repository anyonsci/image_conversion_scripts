"""Video metadata probing via ffprobe."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any, Optional

from .models import VideoInfo
from .toolchain import Toolchain


class ProbeError(RuntimeError):
    pass


class VideoProber:
    def __init__(self, toolchain: Toolchain) -> None:
        self._tools = toolchain

    def probe(self, path: Path | str) -> VideoInfo:
        p = Path(path).resolve()
        if not p.is_file():
            raise ProbeError(f"File not found: {p}")

        cmd = [
            self._tools.ffprobe_bin,
            "-v", "error",
            "-show_format",
            "-show_streams",
            "-of", "json",
            str(p),
        ]

        try:
            res = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=True,
            )
            data = json.loads(res.stdout)
        except subprocess.CalledProcessError as e:
            raise ProbeError(f"ffprobe failed for '{p}': {e.stderr}") from e
        except json.JSONDecodeError as e:
            raise ProbeError(f"Failed to parse ffprobe JSON output for '{p}': {e}") from e

        streams = data.get("streams", [])
        fmt = data.get("format", {})

        video_stream: Optional[dict[str, Any]] = None
        audio_stream: Optional[dict[str, Any]] = None

        for s in streams:
            ctype = s.get("codec_type")
            if ctype == "video" and video_stream is None:
                video_stream = s
            elif ctype == "audio" and audio_stream is None:
                audio_stream = s

        if not video_stream:
            raise ProbeError(f"No video stream found in '{p}'")

        vcodec = video_stream.get("codec_name", "unknown")
        width = int(video_stream.get("width", 0))
        height = int(video_stream.get("height", 0))
        pix_fmt = video_stream.get("pix_fmt", "")

        # Bit depth detection
        raw_bits = video_stream.get("bits_per_raw_sample")
        if raw_bits and str(raw_bits).isdigit():
            bit_depth = int(raw_bits)
        elif "10" in pix_fmt or "12" in pix_fmt:
            bit_depth = 10
        else:
            bit_depth = 8

        # Color & HDR detection
        color_primaries = video_stream.get("color_primaries")
        color_transfer = video_stream.get("color_transfer")
        color_space = video_stream.get("color_space")

        is_hdr = False
        if color_transfer in ("smpte2084", "arib-std-b67") or color_primaries == "bt2020":
            is_hdr = True

        # FPS calculation
        fps = 30.0
        avg_fps_str = video_stream.get("avg_frame_rate", "0/0")
        if "/" in avg_fps_str:
            num, den = avg_fps_str.split("/", 1)
            try:
                n, d = float(num), float(den)
                if d > 0:
                    fps = n / d
            except ValueError:
                pass

        # Duration detection
        duration = 0.0
        dur_str = video_stream.get("duration") or fmt.get("duration")
        if dur_str:
            try:
                duration = float(dur_str)
            except ValueError:
                pass

        # Rotation detection from tags or side data
        rotation = 0
        tags = video_stream.get("tags", {})
        if "rotate" in tags:
            try:
                rotation = int(tags["rotate"])
            except ValueError:
                pass
        else:
            for side in video_stream.get("side_data_list", []):
                if "rotation" in side:
                    try:
                        rotation = int(side["rotation"])
                        break
                    except ValueError:
                        pass

        size_bytes = int(fmt.get("size", p.stat().st_size if p.exists() else 0))
        acodec = audio_stream.get("codec_name") if audio_stream else None

        return VideoInfo(
            path=str(p),
            duration=duration,
            width=width,
            height=height,
            fps=round(fps, 3),
            video_codec=vcodec,
            audio_codec=acodec,
            pix_fmt=pix_fmt,
            bit_depth=bit_depth,
            is_hdr=is_hdr,
            rotation=rotation,
            color_primaries=color_primaries,
            color_transfer=color_transfer,
            color_space=color_space,
            size_bytes=size_bytes,
        )
