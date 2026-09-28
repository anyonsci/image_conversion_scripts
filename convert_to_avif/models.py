"""Domain models and configuration."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Optional


class ImageKind(str, Enum):
    JPEG = "jpeg"
    PNG = "png"
    WEBP = "webp"
    AVIF = "avif"
    HEIC = "heic"
    UNKNOWN = "unknown"


class EncodeProfile(str, Enum):
    JPEG_GAINMAP = "jpeg+gainmap"
    JPEG = "jpeg"
    PNG = "png"
    WEBP = "webp"
    HEIC = "heic"
    UNSUPPORTED = "unsupported"


class ConvertStatus(str, Enum):
    CONVERTED = "converted"
    SKIPPED = "skipped"
    FAILED = "failed"
    REJECTED = "rejected"


@dataclass(frozen=True)
class EncodeSettings:
    codec: str = "aom"
    quality: int = 85
    gain_quality: int = 85
    speed: int = 8
    android_compatible: bool = True
    grid: Optional[tuple[int, int]] = None
    adaptive_quality: bool = True
    skip_gain_map: bool = True


@dataclass(frozen=True)
class QaSettings:
    verify: bool = False
    verify_hdr: bool = False
    max_size_ratio: float = 1.2
    min_size_ratio: float = 0.01
    max_dssim: float = 0.002
    min_ssim: float = 0.98
    quarantine_dir: Optional[str] = None

    def __post_init__(self) -> None:
        if self.verify_hdr and not self.verify:
            object.__setattr__(self, "verify", True)


@dataclass(frozen=True)
class ProbeResult:
    path: str
    kind: ImageKind
    has_gain_map: bool = False
    has_exif: bool = False
    has_icc: bool = False
    width: int = 0
    height: int = 0
    size_bytes: int = 0
    estimated_quality: Optional[int] = None
    bpp: float = 0.0

    @property
    def profile(self) -> EncodeProfile:
        if self.kind is ImageKind.JPEG and self.has_gain_map:
            return EncodeProfile.JPEG_GAINMAP
        if self.kind is ImageKind.JPEG:
            return EncodeProfile.JPEG
        if self.kind is ImageKind.PNG:
            return EncodeProfile.PNG
        if self.kind is ImageKind.WEBP:
            return EncodeProfile.WEBP
        if self.kind is ImageKind.HEIC:
            return EncodeProfile.HEIC
        return EncodeProfile.UNSUPPORTED


@dataclass
class QaOutcome:
    ok: bool
    notes: list[str] = field(default_factory=list)
    dssim: Optional[float] = None
    ssim: Optional[float] = None

    def extend(self, other: "QaOutcome") -> "QaOutcome":
        return QaOutcome(
            ok=self.ok and other.ok,
            notes=[*self.notes, *other.notes],
            dssim=other.dssim if other.dssim is not None else self.dssim,
            ssim=other.ssim if other.ssim is not None else self.ssim,
        )


@dataclass
class ConvertResult:
    source: str
    output: str
    profile: str
    status: ConvertStatus
    message: str = ""
    size_ratio: float = 0.0
    src_bytes: int = 0
    dst_bytes: int = 0
    duration_sec: float = 0.0
    dimensions: str = ""
    dssim: Optional[float] = None
    ssim: Optional[float] = None
    qa: list[str] = field(default_factory=list)
    effective_q: Optional[int] = None
    q_reason: str = ""

    @classmethod
    def skipped(
        cls,
        source: str,
        output: str,
        profile: EncodeProfile,
        message: str,
        src_bytes: int = 0,
        dst_bytes: int = 0,
        dimensions: str = "",
        duration_sec: float = 0.0,
    ) -> "ConvertResult":
        return cls(
            source=source,
            output=output,
            profile=profile.value,
            status=ConvertStatus.SKIPPED,
            message=message,
            src_bytes=src_bytes,
            dst_bytes=dst_bytes,
            dimensions=dimensions,
            duration_sec=duration_sec,
        )

    @classmethod
    def failed(
        cls,
        source: str,
        output: str,
        profile: EncodeProfile,
        message: str,
        src_bytes: int = 0,
        dimensions: str = "",
        duration_sec: float = 0.0,
    ) -> "ConvertResult":
        return cls(
            source=source,
            output=output,
            profile=profile.value,
            status=ConvertStatus.FAILED,
            message=message,
            src_bytes=src_bytes,
            dimensions=dimensions,
            duration_sec=duration_sec,
        )

    @classmethod
    def from_qa(
        cls,
        source: str,
        output: str,
        profile: EncodeProfile,
        *,
        size_ratio: float,
        src_bytes: int = 0,
        dst_bytes: int = 0,
        dimensions: str = "",
        duration_sec: float = 0.0,
        qa: QaOutcome,
        rejected_message: str,
        effective_q: Optional[int] = None,
        q_reason: str = "",
    ) -> "ConvertResult":
        if qa.ok:
            return cls(
                source=source,
                output=output,
                profile=profile.value,
                status=ConvertStatus.CONVERTED,
                message="ok",
                size_ratio=size_ratio,
                src_bytes=src_bytes,
                dst_bytes=dst_bytes,
                dimensions=dimensions,
                duration_sec=duration_sec,
                dssim=qa.dssim,
                ssim=qa.ssim,
                qa=qa.notes,
                effective_q=effective_q,
                q_reason=q_reason,
            )
        return cls(
            source=source,
            output=output,
            profile=profile.value,
            status=ConvertStatus.REJECTED,
            message=rejected_message,
            size_ratio=size_ratio,
            src_bytes=src_bytes,
            dst_bytes=dst_bytes,
            dimensions=dimensions,
            duration_sec=duration_sec,
            dssim=qa.dssim,
            ssim=qa.ssim,
            qa=qa.notes,
            effective_q=effective_q,
            q_reason=q_reason,
        )

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["status"] = self.status.value
        return data


@dataclass(frozen=True)
class SimilarityScore:
    dssim: Optional[float]
    ssim: Optional[float]
    method: str

    @property
    def available(self) -> bool:
        return self.dssim is not None or self.ssim is not None
