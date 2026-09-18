"""Layered QA gates for conversion confidence."""

from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional

from .constants import EXIF_HINT_KEYS, ICC_HINT_KEYS
from .media import ImageDecoder, MediaError, PngInfo, TemporaryWorkspace
from .metrics import SimilarityMeasurer
from .models import ProbeResult, QaOutcome, QaSettings
from .process import CommandRunner
from .probing import MetadataReader
from .toolchain import Toolchain


class QualityGate(ABC):
    @abstractmethod
    def evaluate(self, probe: ProbeResult, output: Path) -> QaOutcome:
        raise NotImplementedError


class StructuralGate(QualityGate):
    """Tier A: decode, dimensions, size ratio, gain map + metadata presence."""

    def __init__(
        self,
        toolchain: Toolchain,
        settings: QaSettings,
        runner: Optional[CommandRunner] = None,
        decoder: Optional[ImageDecoder] = None,
    ) -> None:
        self._tools = toolchain
        self._settings = settings
        self._runner = runner or CommandRunner()
        self._decoder = decoder or ImageDecoder(toolchain, self._runner)
        self._meta = MetadataReader(toolchain, self._runner)

    def evaluate(self, probe: ProbeResult, output: Path) -> QaOutcome:
        notes: list[str] = []
        if not output.is_file() or output.stat().st_size == 0:
            return QaOutcome(False, ["output missing or empty"])

        ratio = output.stat().st_size / max(probe.size_bytes, 1)
        notes.append(f"size_ratio={ratio:.3f}")
        if ratio > self._settings.max_size_ratio:
            return QaOutcome(False, notes + [f"output larger than {self._settings.max_size_ratio:.0%} of source"])
        if ratio < self._settings.min_size_ratio:
            return QaOutcome(
                False,
                notes + [f"output smaller than {self._settings.min_size_ratio:.2%} of source (suspect corrupt)"],
            )

        dim_outcome = self._check_dimensions(probe, output)
        if not dim_outcome.ok:
            return QaOutcome(False, notes + dim_outcome.notes)
        notes.extend(dim_outcome.notes)

        gm_outcome = self._check_gain_map(probe, output)
        if not gm_outcome.ok:
            return QaOutcome(False, notes + gm_outcome.notes)
        notes.extend(gm_outcome.notes)

        notes.extend(self._check_metadata(probe, output).notes)
        return QaOutcome(True, notes)

    def _check_dimensions(self, probe: ProbeResult, output: Path) -> QaOutcome:
        if not self._tools.avifdec:
            return QaOutcome(True, [])
        with TemporaryWorkspace("avifqa_a_") as tmpdir:
            png = tmpdir / "out.png"
            try:
                self._decoder.to_png(output, png)
            except MediaError:
                return QaOutcome(False, ["avifdec failed"])
            width, height = PngInfo.dimensions(png)
            if width == 0 or height == 0:
                return QaOutcome(False, ["decoded PNG invalid"])
            if probe.width and probe.height and (width, height) != (probe.width, probe.height):
                return QaOutcome(
                    False,
                    [f"dimension mismatch {width}x{height} vs {probe.width}x{probe.height}"],
                )
            return QaOutcome(True, [f"decoded={width}x{height}"])

    def _check_gain_map(self, probe: ProbeResult, output: Path) -> QaOutcome:
        if not probe.has_gain_map:
            return QaOutcome(True, [])
        if not self._tools.has_qgain_map:
            return QaOutcome(True, ["WARN: encoder lacks --qgain-map; gain map likely dropped"])
        if not self._tools.avifgainmaputil:
            return QaOutcome(True, ["WARN: cannot verify gain map (no avifgainmaputil)"])
        if not self._avif_has_gain_map(output):
            return QaOutcome(False, ["source had gain map but AVIF has none"])
        return QaOutcome(True, ["gain_map=present"])

    def _avif_has_gain_map(self, avif_path: Path) -> bool:
        assert self._tools.avifgainmaputil
        text = self._runner.output(
            [self._tools.avifgainmaputil, "printmetadata", str(avif_path)]
        ).lower()
        return "gain" in text and any(
            token in text for token in ("headroom", "alternate", "base", "gamma")
        )

    def _check_metadata(self, probe: ProbeResult, output: Path) -> QaOutcome:
        if not self._tools.exiftool or not (probe.has_exif or probe.has_icc):
            return QaOutcome(True, [])
        meta = self._meta.read(output)
        notes: list[str] = []
        if probe.has_exif:
            notes.append(
                "exif=present"
                if self._meta.has_any(meta, EXIF_HINT_KEYS)
                else "WARN: EXIF not detected on output"
            )
        if probe.has_icc:
            notes.append(
                "icc=present"
                if self._meta.has_any(meta, ICC_HINT_KEYS)
                else "WARN: ICC not detected on output"
            )
        return QaOutcome(True, notes)


class PerceptualGate(QualityGate):
    """Tier B: decode both sides to PNG and compare similarity."""

    def __init__(
        self,
        toolchain: Toolchain,
        settings: QaSettings,
        runner: Optional[CommandRunner] = None,
        decoder: Optional[ImageDecoder] = None,
        measurer: Optional[SimilarityMeasurer] = None,
    ) -> None:
        self._settings = settings
        self._runner = runner or CommandRunner()
        self._decoder = decoder or ImageDecoder(toolchain, self._runner)
        self._measurer = measurer or SimilarityMeasurer(toolchain, self._runner)

    def evaluate(self, probe: ProbeResult, output: Path) -> QaOutcome:
        with TemporaryWorkspace("avifqa_b_") as tmpdir:
            src_png = tmpdir / "src.png"
            out_png = tmpdir / "out.png"
            try:
                self._decoder.to_png(Path(probe.path), src_png)
                self._decoder.to_png(output, out_png)
            except MediaError as exc:
                return QaOutcome(False, [str(exc)])

            src_dims = PngInfo.dimensions(src_png)
            out_dims = PngInfo.dimensions(out_png)
            if src_dims != out_dims:
                return QaOutcome(
                    False,
                    [f"compare dim mismatch {out_dims[0]}x{out_dims[1]} vs {src_dims[0]}x{src_dims[1]}"],
                )

            score = self._measurer.compare(src_png, out_png)
            if not score.available:
                return QaOutcome(
                    False,
                    [f"no perceptual metric available ({score.method}); install dssim or ffmpeg"],
                )

            notes = [f"metric={score.method}"]
            if score.dssim is not None:
                notes.append(f"dssim={score.dssim:.6f}")
            if score.ssim is not None:
                notes.append(f"ssim={score.ssim:.6f}")

            ok = True
            if score.dssim is not None and score.dssim > self._settings.max_dssim:
                ok = False
                notes.append(f"dssim>{self._settings.max_dssim}")
            if score.ssim is not None and score.ssim < self._settings.min_ssim:
                ok = False
                notes.append(f"ssim<{self._settings.min_ssim}")
            return QaOutcome(ok, notes, dssim=score.dssim, ssim=score.ssim)


class HdrInformationalGate(QualityGate):
    """Tier C: tonemap checks (informational; does not hard-fail on mild drift)."""

    def __init__(
        self,
        toolchain: Toolchain,
        runner: Optional[CommandRunner] = None,
        decoder: Optional[ImageDecoder] = None,
        measurer: Optional[SimilarityMeasurer] = None,
    ) -> None:
        self._tools = toolchain
        self._runner = runner or CommandRunner()
        self._decoder = decoder or ImageDecoder(toolchain, self._runner)
        self._measurer = measurer or SimilarityMeasurer(toolchain, self._runner)

    def evaluate(self, probe: ProbeResult, output: Path) -> QaOutcome:
        if not probe.has_gain_map:
            return QaOutcome(True, [])
        if not self._tools.avifgainmaputil or not self._tools.has_tonemap:
            return QaOutcome(True, ["HDR tonemap compare skipped (no avifgainmaputil tonemap)"])

        with TemporaryWorkspace("avifqa_c_") as tmpdir:
            hdr_png = tmpdir / "hdr.png"
            if not self._tonemap(output, hdr_png):
                return QaOutcome(True, ["WARN: tonemap failed; skipped HDR compare"])

            src_png = tmpdir / "src.png"
            try:
                self._decoder.to_png(Path(probe.path), src_png)
            except MediaError:
                return QaOutcome(True, ["WARN: source decode failed for HDR compare"])

            score = self._measurer.compare(src_png, hdr_png)
            notes = [f"hdr_metric={score.method}"]
            if score.dssim is not None:
                notes.append(f"hdr_vs_base_dssim={score.dssim:.6f}")
            if (
                score.ssim is not None
                and score.ssim > 0.999
                and score.dssim is not None
                and score.dssim < 1e-6
            ):
                notes.append("WARN: tonemap identical to base (gain map may be inert)")
            return QaOutcome(True, notes)

    def _tonemap(self, avif_path: Path, hdr_png: Path) -> bool:
        assert self._tools.avifgainmaputil
        for args in (
            [self._tools.avifgainmaputil, "tonemap", str(avif_path), str(hdr_png), "--headroom", "1"],
            [self._tools.avifgainmaputil, "tonemap", str(avif_path), str(hdr_png)],
        ):
            proc = self._runner.run(args)
            if proc.returncode == 0 and hdr_png.is_file():
                return True
        return False


class QualityAssessor:
    """Runs configured gates in order and merges outcomes."""

    def __init__(self, toolchain: Toolchain, settings: QaSettings, runner: Optional[CommandRunner] = None) -> None:
        runner = runner or CommandRunner()
        decoder = ImageDecoder(toolchain, runner)
        measurer = SimilarityMeasurer(toolchain, runner)
        self._gates: list[QualityGate] = [StructuralGate(toolchain, settings, runner, decoder)]
        if settings.verify:
            self._gates.append(PerceptualGate(toolchain, settings, runner, decoder, measurer))
        if settings.verify_hdr:
            self._gates.append(HdrInformationalGate(toolchain, runner, decoder, measurer))

    def assess(self, probe: ProbeResult, output: Path) -> QaOutcome:
        outcome = QaOutcome(True, [])
        for gate in self._gates:
            outcome = outcome.extend(gate.evaluate(probe, output))
            if not outcome.ok:
                break
        return outcome
