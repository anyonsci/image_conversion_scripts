"""Domain models and configuration for video conversion."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Optional


class ConvertStatus(str, Enum):
    CONVERTED = "converted"
    SKIPPED = "skipped"
    FAILED = "failed"
    REJECTED = "rejected"


@dataclass(frozen=True)
class VideoInfo:
    path: str
    duration: float
    width: int
    height: int
    fps: float
    video_codec: str
    audio_codec: Optional[str]
    pix_fmt: str
    bit_depth: int
    is_hdr: bool
    rotation: int = 0
    color_primaries: Optional[str] = None
    color_transfer: Optional[str] = None
    color_space: Optional[str] = None
    size_bytes: int = 0

    @property
    def is_av1(self) -> bool:
        return self.video_codec.lower() in ("av1", "av01")


@dataclass(frozen=True)
class EncodeSettings:
    crf: int = 28
    preset: int = 6
    adaptive_quality: bool = True
    svt_params: str = "tune=0:fast-decode=1"
    audio_codec: str = "auto"
    audio_bitrate: str = "192k"
    threads: int = 2
    faststart: bool = True
    delete_original: bool = False
    log_file: Optional[str] = "video_conversion.log"


@dataclass(frozen=True)
class QaSettings:
    verify: bool = True
    max_duration_diff_sec: float = 1.0
    min_size_ratio: float = 0.01
    max_size_ratio: float = 0.95  # Must save at least 5% (out_size <= 0.95 * orig_size)
    quarantine_dir: Optional[str] = None


@dataclass(frozen=True)
class ConvertResult:
    status: ConvertStatus
    source: str
    output: Optional[str]
    original_size: int = 0
    converted_size: int = 0
    duration_sec: float = 0.0
    error_message: Optional[str] = None
    qa_passed: bool = False

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["status"] = self.status.value
        return data
