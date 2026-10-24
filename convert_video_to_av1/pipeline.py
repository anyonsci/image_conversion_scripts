"""Conversion orchestration for videos: single file and batch."""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Iterable, Optional

from .constants import VIDEO_EXTENSIONS
from .encoding import EncodeError, VideoEncoder
from .models import (
    ConvertResult,
    ConvertStatus,
    EncodeSettings,
    QaSettings,
    VideoInfo,
)
from .probing import ProbeError, VideoProber
from .qa import QaError, VideoQualityAssessor
from .toolchain import Toolchain


class InputScanner:
    @staticmethod
    def iter_videos(root: Path) -> Iterable[Path]:
        if root.is_file():
            if root.suffix.lower() in VIDEO_EXTENSIONS:
                yield root
            return
        for path in sorted(root.rglob("*")):
            if path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS:
                # Quickly skip already-converted AV1 videos by filename suffix
                if not path.name.lower().endswith(".av1.mp4"):
                    yield path


class VideoConverter:
    def __init__(
        self,
        toolchain: Toolchain,
        encode: EncodeSettings,
        qa: QaSettings,
        *,
        dry_run: bool = False,
        force: bool = False,
    ) -> None:
        self._tools = toolchain
        self._encode = encode
        self._qa = qa
        self._dry_run = dry_run
        self._force = force
        self._prober = VideoProber(toolchain)
        self._encoder = VideoEncoder(toolchain, encode)
        self._qa_assessor = VideoQualityAssessor(toolchain, qa)

    def convert_file(self, source: Path, output: Path) -> ConvertResult:
        source = source.resolve()
        output = output.resolve()

        if not source.exists():
            return ConvertResult(
                status=ConvertStatus.FAILED,
                source=str(source),
                output=None,
                error_message="Source file does not exist",
            )

        # Quick check by filename suffix: skip already-converted AV1 videos immediately
        if source.name.lower().endswith(".av1.mp4") and not self._force:
            size = source.stat().st_size if source.exists() else 0
            return ConvertResult(
                status=ConvertStatus.SKIPPED,
                source=str(source),
                output=str(output),
                original_size=size,
                converted_size=size,
                error_message="Video file already has .av1.mp4 suffix",
            )

        # 1. Probe source
        try:
            info = self._prober.probe(source)
        except Exception as e:
            return ConvertResult(
                status=ConvertStatus.FAILED,
                source=str(source),
                output=None,
                error_message=f"Probe failed: {e}",
            )

        # Check if already AV1
        if info.is_av1 and not self._force:
            return ConvertResult(
                status=ConvertStatus.SKIPPED,
                source=str(source),
                output=str(output),
                original_size=info.size_bytes,
                converted_size=info.size_bytes,
                duration_sec=info.duration,
                error_message="Video codec is already AV1",
            )

        # Check if output already exists
        if output.exists() and not self._force and output != source:
            return ConvertResult(
                status=ConvertStatus.SKIPPED,
                source=str(source),
                output=str(output),
                original_size=info.size_bytes,
                converted_size=output.stat().st_size,
                duration_sec=info.duration,
                error_message="Output file already exists",
            )

        # Check if source video is already heavily compressed (e.g. WhatsApp, web video)
        if self._encode.skip_low_bitrate and not self._force and info.is_low_bitrate:
            kbps = info.bitrate_bps / 1000.0 if info.bitrate_bps > 0 else 0
            return ConvertResult(
                status=ConvertStatus.SKIPPED,
                source=str(source),
                output=str(output),
                original_size=info.size_bytes,
                converted_size=info.size_bytes,
                duration_sec=info.duration,
                error_message=(
                    f"Video is already highly compressed (Bitrate: {kbps:.0f} kbps, "
                    f"BPPF: {info.bppf:.3f}). Skipping to prevent generation loss and CPU waste."
                ),
            )

        if self._dry_run:
            return ConvertResult(
                status=ConvertStatus.SKIPPED,
                source=str(source),
                output=str(output),
                original_size=info.size_bytes,
                duration_sec=info.duration,
                error_message="Dry-run simulated",
            )

        # 2. Encode to atomic temporary file
        temp_out = output.parent / f"{output.name}.tmp.mp4"
        try:
            elapsed = self._encoder.encode(info, temp_out)
        except EncodeError as e:
            if temp_out.exists():
                temp_out.unlink()
            return ConvertResult(
                status=ConvertStatus.FAILED,
                source=str(source),
                output=None,
                original_size=info.size_bytes,
                duration_sec=info.duration,
                error_message=str(e),
            )

        # 3. QA Validation
        try:
            passed, msg = self._qa_assessor.validate(info, temp_out)
        except QaError as e:
            self._qa_assessor.handle_rejection(temp_out, str(e))
            return ConvertResult(
                status=ConvertStatus.REJECTED,
                source=str(source),
                output=None,
                original_size=info.size_bytes,
                duration_sec=info.duration,
                error_message=str(e),
                qa_passed=False,
            )

        # 4. Mirror all metadata (EXIF/QuickTime/XMP) and filesystem timestamps
        if self._tools.exiftool_bin and temp_out.exists() and source.exists():
            try:
                subprocess.run(
                    [
                        self._tools.exiftool_bin,
                        "-overwrite_original",
                        "-TagsFromFile", str(source),
                        "-all:all",
                        "-api", "QuickTimeUTC",
                        str(temp_out),
                    ],
                    capture_output=True,
                    check=False,
                )
            except Exception:
                pass

        try:
            if source.exists() and temp_out.exists():
                shutil.copystat(source, temp_out)
        except OSError:
            pass

        # 5. Atomic move to target
        if temp_out.exists():
            temp_out.replace(output)

        try:
            if source.exists() and output.exists():
                shutil.copystat(source, output)
        except OSError:
            pass

        out_size = output.stat().st_size

        # 6. Safe cleanup of source if requested
        if self._encode.delete_original and output.exists() and output != source:
            try:
                source.unlink()
            except OSError as e:
                pass

        return ConvertResult(
            status=ConvertStatus.CONVERTED,
            source=str(source),
            output=str(output),
            original_size=info.size_bytes,
            converted_size=out_size,
            duration_sec=info.duration,
            qa_passed=True,
        )
