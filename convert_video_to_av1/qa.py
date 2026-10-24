"""Video QA validation: size, stream integrity, duration, and decode test."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from .models import QaSettings, VideoInfo
from .probing import VideoProber
from .toolchain import Toolchain


class QaError(RuntimeError):
    pass


class VideoQualityAssessor:
    def __init__(self, toolchain: Toolchain, qa_settings: QaSettings) -> None:
        self._tools = toolchain
        self._qa = qa_settings
        self._prober = VideoProber(toolchain)

    def validate(self, source_info: VideoInfo, output_path: Path) -> tuple[bool, str]:
        if not self._qa.verify:
            return True, "QA verification disabled"

        if not output_path.exists():
            raise QaError(f"QA Failed: Output file does not exist: {output_path}")

        out_size = output_path.stat().st_size
        if out_size < 1000:
            raise QaError(f"QA Failed: Converted video is suspiciously small ({out_size} bytes)")

        # 1. Size ratio check (must achieve at least 5% space savings; no file bloat or negligible compression)
        if source_info.size_bytes > 0:
            ratio = out_size / source_info.size_bytes
            savings_pct = (1.0 - ratio) * 100.0
            if ratio > self._qa.max_size_ratio:
                min_saving_pct = (1.0 - self._qa.max_size_ratio) * 100.0
                raise QaError(
                    f"QA Failed: Insufficient compression. Converted AV1 ({out_size} bytes) is "
                    f"{ratio:.1%} of original ({source_info.size_bytes} bytes), saving only {savings_pct:.1f}% "
                    f"(minimum required savings: {min_saving_pct:.0f}%)."
                )
            if ratio < self._qa.min_size_ratio:
                raise QaError(
                    f"QA Failed: Suspiciously small size ratio ({ratio:.3f}). "
                    f"AV1: {out_size} bytes vs Source: {source_info.size_bytes} bytes"
                )

        # 2. Probe converted file
        try:
            out_info = self._prober.probe(output_path)
        except Exception as e:
            raise QaError(f"QA Failed: Could not probe converted file: {e}") from e

        if not out_info.is_av1:
            raise QaError(f"QA Failed: Converted codec is '{out_info.video_codec}', expected 'av1'")

        # 3. Resolution parity check (allow swapped width/height if rotation was applied)
        direct_match = (out_info.width == source_info.width) and (out_info.height == source_info.height)
        swapped_match = (out_info.width == source_info.height) and (out_info.height == source_info.width)
        if not (direct_match or swapped_match):
            raise QaError(
                f"QA Failed: Resolution mismatch. Source: {source_info.width}x{source_info.height}, "
                f"AV1: {out_info.width}x{out_info.height}"
            )

        # 4. Audio presence check
        if source_info.audio_codec and not out_info.audio_codec:
            raise QaError("QA Failed: Source video had audio, but converted AV1 output has no audio stream")

        # 5. Duration match check
        if source_info.duration > 0 and out_info.duration > 0:
            diff = abs(out_info.duration - source_info.duration)
            if diff > self._qa.max_duration_diff_sec and (diff / source_info.duration) > 0.02:
                raise QaError(
                    f"QA Failed: Duration mismatch. Source: {source_info.duration:.2f}s, "
                    f"AV1: {out_info.duration:.2f}s (diff: {diff:.2f}s)"
                )

        # 6. Lossless full-stream decode integrity test
        try:
            decode_res = subprocess.run(
                [
                    self._tools.ffmpeg_bin,
                    "-v", "error",
                    "-i", str(output_path),
                    "-f", "null",
                    "-",
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            if decode_res.returncode != 0:
                err_text = decode_res.stderr.strip()
                raise QaError(f"QA Failed: AV1 bitstream decode test failed: {err_text}")
        except subprocess.SubprocessError as e:
            raise QaError(f"QA Failed: Failed to execute decode test: {e}") from e

        return True, "All QA checks passed"

    def handle_rejection(self, output_path: Path, reason: str) -> None:
        if self._qa.quarantine_dir:
            quarantine = Path(self._qa.quarantine_dir)
            quarantine.mkdir(parents=True, exist_ok=True)
            target = quarantine / output_path.name
            shutil.move(str(output_path), str(target))
        else:
            if output_path.exists():
                output_path.unlink()
