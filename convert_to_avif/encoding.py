"""AVIF encoding via avifenc."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from .media import ImageDecoder, MediaError, TemporaryWorkspace
from .models import EncodeSettings, ProbeResult
from .process import CommandRunner
from .toolchain import Toolchain


class EncodeError(RuntimeError):
    pass


class AvifEncoder:
    def __init__(
        self,
        toolchain: Toolchain,
        settings: EncodeSettings,
        runner: Optional[CommandRunner] = None,
        decoder: Optional[ImageDecoder] = None,
    ) -> None:
        self._tools = toolchain
        self._settings = settings
        self._runner = runner or CommandRunner()
        self._decoder = decoder or ImageDecoder(toolchain, self._runner)

    def encode(self, probe: ProbeResult, output: Path) -> None:
        output.parent.mkdir(parents=True, exist_ok=True)
        with TemporaryWorkspace("avifenc_in_") as tmpdir:
            try:
                enc_input, with_alpha = self._decoder.rasterize_for_encoder(
                    Path(probe.path), probe.kind, tmpdir
                )
            except MediaError as exc:
                raise EncodeError(str(exc)) from exc

            cmd = self._build_command(
                enc_input,
                output,
                with_alpha=with_alpha,
                with_gain_map=probe.has_gain_map,
            )
            proc = self._runner.run(cmd)
            if proc.returncode != 0 or not output.is_file():
                if output.exists():
                    output.unlink(missing_ok=True)
                lines = ((proc.stderr or "") + (proc.stdout or "") or "avifenc failed").strip().splitlines()
                raise EncodeError(lines[-1] if lines else "avifenc failed")

    def _build_command(
        self,
        input_path: Path,
        output: Path,
        *,
        with_alpha: bool,
        with_gain_map: bool,
    ) -> list[str]:
        cmd = [
            self._tools.avifenc,
            "-q",
            str(self._settings.quality),
            "-s",
            str(self._settings.speed),
            "-j",
            "1",
        ]
        if with_alpha:
            cmd.extend(["--qalpha", str(self._settings.quality)])
        if with_gain_map and self._tools.has_qgain_map:
            cmd.extend(["--qgain-map", str(self._settings.gain_quality)])
        cmd.extend(["--no-overwrite", str(input_path), str(output)])
        return cmd
