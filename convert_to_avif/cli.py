"""CLI entrypoint."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Optional

from .constants import INSTALL_HINT
from .models import EncodeSettings, QaSettings
from .pipeline import BatchRunner, InputScanner, JobSpec, PathMapper
from .toolchain import ToolchainError, ToolchainFactory


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Convert images to AVIF with gain-map awareness and QA gates.",
        epilog=INSTALL_HINT,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("input", help="Input file or directory")
    parser.add_argument(
        "-o",
        "--output",
        help="Output file or directory (default: <input>_avif for dirs, <stem>.avif for files)",
    )
    parser.add_argument("-q", "--quality", type=int, default=85, help="avifenc -q color quality (default 85)")
    parser.add_argument(
        "--qgain-map",
        type=int,
        default=85,
        dest="gain_quality",
        help="Gain map quality 0-100 (default 85)",
    )
    parser.add_argument("-s", "--speed", type=int, default=4, help="Encoder speed 0-10 (default 4)")
    parser.add_argument(
        "-j",
        "--jobs",
        type=int,
        default=max(1, (os.cpu_count() or 2) // 2),
        help="Parallel conversions (default: 50%% of CPUs)",
    )
    parser.add_argument("--dry-run", action="store_true", help="Probe and print profiles only")
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Tier B perceptual compare (decode AVIF vs source; not JPG roundtrip)",
    )
    parser.add_argument(
        "--verify-hdr",
        action="store_true",
        help="Also run gain-map tonemap informational checks",
    )
    parser.add_argument("--max-dssim", type=float, default=0.002, help="Max DSSIM when --verify (default 0.002)")
    parser.add_argument("--min-ssim", type=float, default=0.98, help="Min SSIM when --verify (default 0.98)")
    parser.add_argument(
        "--max-size-ratio",
        type=float,
        default=1.2,
        help="Fail if AVIF larger than this fraction of source (default 1.2)",
    )
    parser.add_argument(
        "--min-size-ratio",
        type=float,
        default=0.01,
        help="Fail if AVIF smaller than this fraction of source (default 0.01)",
    )
    parser.add_argument("--quarantine", help="Move QA-rejected outputs here instead of deleting")
    parser.add_argument("--json-summary", action="store_true", help="Print JSON summary on stdout at end")
    return parser


def resolve_output_root(input_path: Path, output_arg: Optional[str]) -> Path:
    if output_arg:
        return Path(output_arg).resolve()
    if input_path.is_dir():
        return Path(str(input_path) + "_avif")
    return input_path.with_suffix(".avif")


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    input_path = Path(args.input).resolve()
    if not input_path.exists():
        print(f"ERROR: input not found: {input_path}", file=sys.stderr)
        return 2

    try:
        toolchain = ToolchainFactory().discover()
    except ToolchainError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    for line in toolchain.report_lines():
        print(line)

    encode = EncodeSettings(quality=args.quality, gain_quality=args.gain_quality, speed=args.speed)
    qa = QaSettings(
        verify=args.verify,
        verify_hdr=args.verify_hdr,
        max_size_ratio=args.max_size_ratio,
        min_size_ratio=args.min_size_ratio,
        max_dssim=args.max_dssim,
        min_ssim=args.min_ssim,
        quarantine_dir=args.quarantine,
    )

    if qa.verify and not (toolchain.dssim or toolchain.ffmpeg):
        print(
            "WARNING: --verify needs dssim or ffmpeg (or Pillow+numpy) for metrics.",
            file=sys.stderr,
        )

    files = list(InputScanner.iter_images(input_path))
    if not files:
        print("No images found.", file=sys.stderr)
        return 1

    output_root = resolve_output_root(input_path, args.output)
    mapper = PathMapper(input_path, output_root)
    jobs = [JobSpec(str(src), str(mapper.map(src))) for src in files]

    print(f"Source: {input_path}")
    print(f"Target: {output_root}")
    print(f"Files:  {len(files)}  jobs={args.jobs}  verify={qa.verify}")
    print(f"Encode: q={encode.quality} qgain={encode.gain_quality} speed={encode.speed}")

    summary = BatchRunner(
        toolchain,
        encode,
        qa,
        jobs=args.jobs,
        dry_run=args.dry_run,
    ).run(jobs)

    for line in summary.format_lines():
        print(line)

    if args.json_summary:
        print(json.dumps([r.to_dict() for r in summary.results], indent=2))

    return 1 if summary.failed else 0
