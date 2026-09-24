"""Conversion orchestration: single file + batch."""

from __future__ import annotations

import os
import statistics
import time
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
        threads: int = 1,
    ) -> None:
        self._tools = toolchain
        self._encode = encode
        self._qa = qa
        self._dry_run = dry_run
        runner = runner or CommandRunner()
        self._prober = ImageProber(toolchain, runner)
        self._encoder = AvifEncoder(toolchain, encode, runner, threads=threads)
        self._assessor = QualityAssessor(toolchain, qa, runner)

    def convert(self, source: Path, output: Path) -> ConvertResult:
        t0 = time.monotonic()
        src_s, out_s = str(source), str(output)

        # Fast path: skip immediately without running probe if valid output already exists
        if output.is_file() and output.stat().st_size > 0:
            return ConvertResult.skipped(
                src_s, out_s, EncodeProfile.JPEG, "output exists",
                dst_bytes=output.stat().st_size, duration_sec=time.monotonic() - t0
            )
        # Clean up any leftover 0-byte file from a previous aborted attempt
        if output.is_file() and output.stat().st_size == 0:
            output.unlink(missing_ok=True)

        probe = self._prober.probe(source)
        profile = probe.profile
        dims = f"{probe.width}x{probe.height}" if probe.width and probe.height else ""
        src_bytes = probe.size_bytes

        if profile is EncodeProfile.UNSUPPORTED:
            return ConvertResult.skipped(
                src_s, out_s, profile, "unsupported type",
                src_bytes=src_bytes, dimensions=dims, duration_sec=time.monotonic() - t0
            )
        if self._dry_run:
            return ConvertResult.skipped(
                src_s, out_s, profile, f"dry-run would encode as {profile.value}",
                src_bytes=src_bytes, dimensions=dims, duration_sec=time.monotonic() - t0
            )

        try:
            self._encoder.encode(probe, output)
        except EncodeError as exc:
            return ConvertResult.failed(
                src_s, out_s, profile, str(exc),
                src_bytes=src_bytes, dimensions=dims, duration_sec=time.monotonic() - t0
            )

        outcome = self._assessor.assess(probe, output)
        dst_bytes = output.stat().st_size if output.is_file() else 0
        ratio = dst_bytes / max(src_bytes, 1)
        duration = time.monotonic() - t0

        if outcome.ok:
            return ConvertResult.from_qa(
                src_s,
                out_s,
                profile,
                size_ratio=ratio,
                src_bytes=src_bytes,
                dst_bytes=dst_bytes,
                dimensions=dims,
                duration_sec=duration,
                qa=outcome,
                rejected_message="",
            )

        rejected_message = self._quarantine_or_delete(output)
        return ConvertResult.from_qa(
            src_s,
            out_s,
            profile,
            size_ratio=ratio,
            src_bytes=src_bytes,
            dst_bytes=dst_bytes,
            dimensions=dims,
            duration_sec=duration,
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


def _fmt_size(b: int) -> str:
    if b <= 0:
        return "0 B"
    if b < 1024:
        return f"{b} B"
    if b < 1024 * 1024:
        return f"{b / 1024:.1f} KB"
    if b < 1024 * 1024 * 1024:
        return f"{b / (1024 * 1024):.2f} MB"
    return f"{b / (1024 * 1024 * 1024):.2f} GB"


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
        total_src = sum(r.src_bytes for r in self.converted)
        total_dst = sum(r.dst_bytes for r in self.converted)
        durations = [r.duration_sec for r in self.converted if r.duration_sec]

        if total_src > 0 and total_dst > 0:
            saved = total_src - total_dst
            pct = (saved / total_src) * 100
            lines.append(f"storage:    {_fmt_size(total_src)} -> {_fmt_size(total_dst)} (saved {_fmt_size(saved)}, -{pct:.1f}%)")

        if durations:
            total_time = sum(durations)
            avg_dur = statistics.mean(durations)
            total_s = int(total_time)
            hrs = total_s // 3600
            mins = (total_s % 3600) // 60
            secs = total_s % 60
            time_str = f"{hrs}h {mins}m {secs}s" if hrs > 0 else (f"{mins}m {secs}s" if mins > 0 else f"{secs}s")
            lines.append(f"total_time: {time_str} (avg {avg_dur:.1f}s/image)")

        ratios = [r.size_ratio for r in self.converted if r.size_ratio > 0]
        if ratios:
            lines.append(
                f"size_ratio: p50={statistics.median(ratios):.3f} "
                f"mean={statistics.mean(ratios):.3f} "
                f"max={max(ratios):.3f}"
            )
        dssims = [r.dssim for r in self.converted if r.dssim is not None]
        if dssims:
            lines.append(f"dssim:      mean={statistics.mean(dssims):.5f} max={max(dssims):.5f}")
        ssims = [r.ssim for r in self.converted if r.ssim is not None]
        if ssims:
            lines.append(f"ssim:       mean={statistics.mean(ssims):.5f} min={min(ssims):.5f}")
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
        total = len(jobs)

        if self._jobs == 1 or self._dry_run:
            encoder_threads = max(1, os.cpu_count() or 1)
            converter = Converter(
                self._tools,
                self._encode,
                self._qa,
                dry_run=self._dry_run,
                threads=encoder_threads,
            )
            for idx, job in enumerate(jobs, 1):
                result = converter.convert(Path(job.source), Path(job.output))
                results.append(result)
                self._emit(result, index=idx, total=total)
            return BatchSummary(results)

        with ProcessPoolExecutor(max_workers=self._jobs) as pool:
            futures = {
                pool.submit(_worker_convert, config, job.source, job.output): job for job in jobs
            }
            for idx, future in enumerate(as_completed(futures), 1):
                data = future.result()
                result = ConvertResult(
                    source=data["source"],
                    output=data["output"],
                    profile=data["profile"],
                    status=ConvertStatus(data["status"]),
                    message=data.get("message", ""),
                    size_ratio=data.get("size_ratio", 0.0),
                    src_bytes=data.get("src_bytes", 0),
                    dst_bytes=data.get("dst_bytes", 0),
                    duration_sec=data.get("duration_sec", 0.0),
                    dimensions=data.get("dimensions", ""),
                    dssim=data.get("dssim"),
                    ssim=data.get("ssim"),
                    qa=data.get("qa") or [],
                )
                results.append(result)
                self._emit(result, index=idx, total=total)
        return BatchSummary(results)

    @staticmethod
    def _emit(result: ConvertResult, index: Optional[int] = None, total: int = 0) -> None:
        ts = time.strftime("%H:%M:%S")
        prefix = f"[{ts}] [{index:>{len(str(total))}}/{total}]" if index and total else f"[{ts}]"
        src_name = Path(result.source).name
        status = result.status.value

        if result.status is ConvertStatus.CONVERTED:
            src_sz = _fmt_size(result.src_bytes)
            dst_sz = _fmt_size(result.dst_bytes)
            pct = (1.0 - result.size_ratio) * 100 if result.size_ratio < 1.0 else (result.size_ratio - 1.0) * -100
            pct_sign = f"-{pct:.1f}%" if result.size_ratio < 1.0 else f"+{-pct:.1f}%"
            dim_str = f" | {result.dimensions}" if result.dimensions else ""
            time_str = f" | {result.duration_sec:.1f}s"
            dssim_str = f" | dssim={result.dssim:.5f}" if result.dssim else ""
            ssim_str = f" | ssim={result.ssim:.4f}" if result.ssim else ""
            print(f"{prefix} {status:9} [{result.profile}] {src_name} | {src_sz} -> {dst_sz} ({pct_sign}){dim_str}{time_str}{dssim_str}{ssim_str}", flush=True)
        elif result.status is ConvertStatus.SKIPPED:
            time_str = f" ({result.duration_sec:.2f}s)" if result.duration_sec > 0.05 else ""
            print(f"{prefix} {status:9} [{result.profile}] {src_name} | {result.message}{time_str}", flush=True)
        else:
            src_sz = f" ({_fmt_size(result.src_bytes)})" if result.src_bytes else ""
            time_str = f" | {result.duration_sec:.1f}s" if result.duration_sec > 0 else ""
            print(f"{prefix} {status:9} [{result.profile}] {src_name}{src_sz} | {result.message}{time_str}", flush=True)
