"""Conversion orchestration: single file + batch."""

from __future__ import annotations

import statistics
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable, Optional

from .constants import IMAGE_EXTENSIONS
from .encoding import AvifEncoder, EncodeError
from .models import (
    ConvertResult,
    ConvertStatus,
    EncodeProfile,
    EncodeSettings,
    QaSettings,
)
from .process import CommandRunner
from .probing import ImageProber
from .qa import QualityAssessor
from .toolchain import Toolchain


@dataclass(frozen=True)
class JobSpec:
    source: str
    output: str


class PathMapper:
    def __init__(self, input_root: Path, output_root: Path) -> None:
        self._input_root = input_root
        self._output_root = output_root

    def map(self, src: Path) -> Path:
        if self._input_root.is_file():
            if self._output_root.suffix.lower() == ".avif":
                return self._output_root
            return self._output_root / f"{src.stem}.avif"
        return self._output_root / src.relative_to(self._input_root).with_suffix(".avif")


class InputScanner:
    @staticmethod
    def iter_images(root: Path) -> Iterable[Path]:
        if root.is_file():
            yield root
            return
        for path in sorted(root.rglob("*")):
            if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS:
                yield path


class Converter:
    """Convert one image with probe → encode → QA."""

    def __init__(
        self,
        toolchain: Toolchain,
        encode: EncodeSettings,
        qa: QaSettings,
        *,
        dry_run: bool = False,
        runner: Optional[CommandRunner] = None,
    ) -> None:
        self._tools = toolchain
        self._encode = encode
        self._qa = qa
        self._dry_run = dry_run
        runner = runner or CommandRunner()
        self._prober = ImageProber(toolchain, runner)
        self._encoder = AvifEncoder(toolchain, encode, runner)
        self._assessor = QualityAssessor(toolchain, qa, runner)

    def convert(self, source: Path, output: Path) -> ConvertResult:
        probe = self._prober.probe(source)
        profile = probe.profile
        src_s, out_s = str(source), str(output)

        if profile is EncodeProfile.UNSUPPORTED:
            return ConvertResult.skipped(src_s, out_s, profile, "unsupported type")
        if output.exists():
            return ConvertResult.skipped(src_s, out_s, profile, "output exists")
        if self._dry_run:
            return ConvertResult.skipped(src_s, out_s, profile, f"dry-run would encode as {profile.value}")

        try:
            self._encoder.encode(probe, output)
        except EncodeError as exc:
            return ConvertResult.failed(src_s, out_s, profile, str(exc))

        outcome = self._assessor.assess(probe, output)
        ratio = output.stat().st_size / max(probe.size_bytes, 1)
        if outcome.ok:
            return ConvertResult.from_qa(
                src_s, out_s, profile, size_ratio=ratio, qa=outcome, rejected_message=""
            )

        rejected_message = self._quarantine_or_delete(output)
        return ConvertResult.from_qa(
            src_s,
            out_s,
            profile,
            size_ratio=ratio,
            qa=outcome,
            rejected_message=rejected_message,
        )

    def _quarantine_or_delete(self, output: Path) -> str:
        if self._qa.quarantine_dir:
            qdir = Path(self._qa.quarantine_dir)
            qdir.mkdir(parents=True, exist_ok=True)
            qpath = qdir / output.name
            output.replace(qpath)
            return f"rejected by QA → {qpath}"
        output.unlink(missing_ok=True)
        return "rejected by QA"


def _worker_convert(config: dict, source: str, output: str) -> dict:
    """Picklable process-pool entrypoint."""
    tools = Toolchain.from_dict(config["tools"])
    encode = EncodeSettings(**config["encode"])
    qa = QaSettings(**config["qa"])
    result = Converter(tools, encode, qa, dry_run=bool(config["dry_run"])).convert(
        Path(source), Path(output)
    )
    return result.to_dict()


@dataclass
class BatchSummary:
    results: list[ConvertResult]

    @property
    def converted(self) -> list[ConvertResult]:
        return [r for r in self.results if r.status is ConvertStatus.CONVERTED]

    @property
    def failed(self) -> list[ConvertResult]:
        return [r for r in self.results if r.status in {ConvertStatus.FAILED, ConvertStatus.REJECTED}]

    @property
    def skipped(self) -> list[ConvertResult]:
        return [r for r in self.results if r.status is ConvertStatus.SKIPPED]

    def format_lines(self) -> list[str]:
        lines = [
            "---",
            f"done: converted={len(self.converted)} failed={len(self.failed)} skipped={len(self.skipped)}",
        ]
        ratios = [r.size_ratio for r in self.converted if r.size_ratio > 0]
        if ratios:
            lines.append(
                "size_ratio: "
                f"p50={statistics.median(ratios):.3f} "
                f"mean={statistics.mean(ratios):.3f} "
                f"max={max(ratios):.3f}"
            )
        dssims = [r.dssim for r in self.converted if r.dssim is not None]
        if dssims:
            lines.append(f"dssim: mean={statistics.mean(dssims):.5f} max={max(dssims):.5f}")
        return lines


class BatchRunner:
    def __init__(
        self,
        toolchain: Toolchain,
        encode: EncodeSettings,
        qa: QaSettings,
        *,
        jobs: int,
        dry_run: bool = False,
    ) -> None:
        self._tools = toolchain
        self._encode = encode
        self._qa = qa
        self._jobs = max(1, jobs)
        self._dry_run = dry_run

    def run(self, jobs: list[JobSpec]) -> BatchSummary:
        config = {
            "tools": self._tools.to_dict(),
            "encode": asdict(self._encode),
            "qa": asdict(self._qa),
            "dry_run": self._dry_run,
        }
        results: list[ConvertResult] = []

        if self._jobs == 1 or self._dry_run:
            converter = Converter(self._tools, self._encode, self._qa, dry_run=self._dry_run)
            for job in jobs:
                result = converter.convert(Path(job.source), Path(job.output))
                results.append(result)
                self._emit(result)
            return BatchSummary(results)

        with ProcessPoolExecutor(max_workers=self._jobs) as pool:
            futures = {
                pool.submit(_worker_convert, config, job.source, job.output): job for job in jobs
            }
            for future in as_completed(futures):
                data = future.result()
                result = ConvertResult(
                    source=data["source"],
                    output=data["output"],
                    profile=data["profile"],
                    status=ConvertStatus(data["status"]),
                    message=data.get("message", ""),
                    size_ratio=data.get("size_ratio", 0.0),
                    dssim=data.get("dssim"),
                    ssim=data.get("ssim"),
                    qa=data.get("qa") or [],
                )
                results.append(result)
                self._emit(result)
        return BatchSummary(results)

    @staticmethod
    def _emit(result: ConvertResult) -> None:
        extra = f" dssim={result.dssim:.5f}" if result.dssim is not None else ""
        print(f"{result.status.value:10} [{result.profile}] {result.source}  {result.message}{extra}")
