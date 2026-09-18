"""Subprocess helpers."""

from __future__ import annotations

import subprocess
from typing import Optional, Sequence


class CommandRunner:
    """Thin wrapper around subprocess for consistent capture/timeout behavior."""

    def run(
        self,
        args: Sequence[str],
        *,
        timeout: Optional[float] = None,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            list(args),
            capture_output=True,
            text=True,
            timeout=timeout,
        )

    def output(self, args: Sequence[str]) -> str:
        proc = self.run(args)
        return (proc.stdout or "") + (proc.stderr or "")

    def ok(self, args: Sequence[str]) -> bool:
        return self.run(args).returncode == 0
