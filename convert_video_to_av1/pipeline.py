"""Conversion orchestration for videos: single file and batch."""

from __future__ import annotations

import os
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

        # 4. Atomic move to target
        if temp_out.exists():
            temp_out.replace(output)

        out_size = output.stat().st_size

        # 5. Safe cleanup of source if requested
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
