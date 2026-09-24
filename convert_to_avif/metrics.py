"""Perceptual similarity metrics."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Optional

from .models import SimilarityScore
from .process import CommandRunner
from .toolchain import Toolchain


class SimilarityMeasurer:
    """Prefer dssim, then ffmpeg ssim, then Pillow+numpy SSIM."""

    def __init__(self, toolchain: Toolchain, runner: Optional[CommandRunner] = None) -> None:
        self._tools = toolchain
        self._runner = runner or CommandRunner()

    def compare(self, png_a: Path, png_b: Path) -> SimilarityScore:
        for method in (self._via_dssim, self._via_ffmpeg, self._via_pillow):
            score = method(png_a, png_b)
            if score is not None:
                return score
        return SimilarityScore(None, None, "unavailable")

    def _via_dssim(self, png_a: Path, png_b: Path) -> Optional[SimilarityScore]:
        if not self._tools.dssim:
            return None
        proc = self._runner.run([self._tools.dssim, str(png_a), str(png_b)])
        match = re.search(r"([0-9]*\.?[0-9]+)", (proc.stdout or "") + (proc.stderr or ""))
        if proc.returncode != 0 or not match:
            return None
        dssim = float(match.group(1))
        return SimilarityScore(dssim, max(0.0, 1.0 - 2.0 * dssim), "dssim")

    def _via_ffmpeg(self, png_a: Path, png_b: Path) -> Optional[SimilarityScore]:
        if not self._tools.ffmpeg:
            return None
        proc = self._runner.run(
            [
                self._tools.ffmpeg,
                "-hide_banner",
                "-i",
                str(png_a),
                "-i",
                str(png_b),
                "-lavfi",
                "ssim",
                "-f",
                "null",
                "-",
            ]
        )
        match = re.search(r"All:([0-9]*\.?[0-9]+)", (proc.stderr or "") + (proc.stdout or ""))
        if not match:
            return None
        ssim = float(match.group(1))
        return SimilarityScore(None, ssim, "ffmpeg-ssim")

    def _via_pillow(self, png_a: Path, png_b: Path) -> Optional[SimilarityScore]:
        try:
            from PIL import Image  # type: ignore
            import numpy as np  # type: ignore
        except ImportError:
            return None
        try:
            a = np.asarray(Image.open(png_a).convert("RGB"), dtype=np.float64)
            b = np.asarray(Image.open(png_b).convert("RGB"), dtype=np.float64)
        except Exception:  # noqa: BLE001
            return None
        if a.shape != b.shape:
            return SimilarityScore(None, None, "shape-mismatch")
        ssim = float(sum(self._ssim_channel(a[:, :, c], b[:, :, c]) for c in range(3)) / 3.0)
        return SimilarityScore(None, ssim, "pillow-ssim")

    @staticmethod
    def _ssim_channel(x, y) -> float:
        c1 = (0.01 * 255) ** 2
        c2 = (0.03 * 255) ** 2
        mu_x = x.mean()
        mu_y = y.mean()
        sigma_x = x.var()
        sigma_y = y.var()
        sigma_xy = ((x - mu_x) * (y - mu_y)).mean()
        num = (2 * mu_x * mu_y + c1) * (2 * sigma_xy + c2)
        den = (mu_x**2 + mu_y**2 + c1) * (sigma_x + sigma_y + c2)
        return float(num / den) if den else 1.0
