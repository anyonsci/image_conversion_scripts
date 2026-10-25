"""Command-line interface for convert_video_to_av1."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .constants import DEFAULT_AUDIO_BITRATE, DEFAULT_CRF, DEFAULT_PRESET, DEFAULT_THREADS
from .models import ConvertResult, ConvertStatus, EncodeSettings, QaSettings
from .pipeline import InputScanner, VideoConverter
from .toolchain import Toolchain, ToolchainError


def parse_args(args: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python3 -m convert_video_to_av1",
        description="Convert MP4, MOV, and other video containers to AV1 with audio handling and QA verification.",
    )
    parser.add_argument("input", type=Path, help="Input video file or directory")
    parser.add_argument(
        "-o", "--output", type=Path, default=None,
        help="Output video file or directory (default: <stem>.av1.mp4 for mp4, <stem>.mp4 for mov/other)",
    )
    parser.add_argument(
        "-crf", "--crf", type=int, default=DEFAULT_CRF,
        help=f"Constant Rate Factor (default: {DEFAULT_CRF}, dynamic range 30-34 for high quality and guaranteed savings)",
    )
    parser.add_argument(
        "--adaptive-quality", action=argparse.BooleanOptionalAction, default=True,
        help="Dynamically scale AV1 CRF (30-34) based on resolution, source bitrate, and HDR bit-depth (default: true)",
    )
    parser.add_argument(
        "--skip-low-bitrate", action=argparse.BooleanOptionalAction, default=True,
        help="Skip already heavily compressed videos (e.g. WhatsApp / web videos with bitrate < 1.2 Mbps or BPPF < 0.04) to prevent generation loss (default: true)",
    )
    parser.add_argument(
        "-p", "--preset", type=int, default=DEFAULT_PRESET,
        help=f"SVT-AV1 preset 0-13 (default: {DEFAULT_PRESET})",
    )
    parser.add_argument(
        "-t", "--threads", type=int, default=DEFAULT_THREADS,
        help=f"Encoding threads / logical processors (default: {DEFAULT_THREADS}, keep low on low-RAM systems)",
    )
    parser.add_argument(
        "--audio-codec", default="auto",
        help="Audio codec: 'auto' (copy if compatible, else aac), 'copy', 'aac', or 'opus' (default: auto)",
    )
    parser.add_argument(
        "--audio-bitrate", default=DEFAULT_AUDIO_BITRATE,
        help=f"Bitrate for re-encoded audio (default: {DEFAULT_AUDIO_BITRATE})",
    )
    parser.add_argument(
        "--min-savings-pct", type=float, default=5.0,
        help="Minimum percentage of space saved required for QA pass (default: 5.0, rejects conversion if savings < 5%% or size increases)",
    )
    parser.add_argument(
        "--log-file", type=str, default="video_conversion.log",
        help="Path to append video conversion and FFmpeg output logs (default: video_conversion.log in current directory)",
    )
    parser.add_argument(
        "--delete-original", action="store_true", default=False,
        help="Delete source video ONLY after successful conversion and QA verification",
    )
    parser.add_argument(
        "--force", action="store_true", default=False,
        help="Re-convert even if file is already AV1 or output exists",
    )
    parser.add_argument(
        "--dry-run", action="store_true", default=False,
        help="Probe and print planned conversions without executing encodes",
    )
    parser.add_argument(
        "--no-verify", action="store_true", default=False,
        help="Skip QA bitstream decode and duration verification",
    )
    parser.add_argument(
        "--quarantine", type=Path, default=None,
        help="Directory to move QA-rejected files into instead of deleting them",
    )
    parser.add_argument(
        "--json-summary", action="store_true", default=False,
        help="Print final summary as JSON to stdout",
    )

    return parser.parse_args(args)


def main(args: list[str] | None = None) -> int:
    parsed = parse_args(args)

    try:
        toolchain = Toolchain.detect()
    except ToolchainError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    input_path = parsed.input.resolve()
    if not input_path.exists():
        print(f"Error: Input path '{input_path}' does not exist.", file=sys.stderr)
        return 1

    encode_settings = EncodeSettings(
        crf=parsed.crf,
        preset=parsed.preset,
        adaptive_quality=parsed.adaptive_quality,
        skip_low_bitrate=parsed.skip_low_bitrate,
        audio_codec=parsed.audio_codec,
        audio_bitrate=parsed.audio_bitrate,
        threads=parsed.threads,
        delete_original=parsed.delete_original,
        log_file=parsed.log_file,
    )

    max_size_ratio = max(0.01, (100.0 - parsed.min_savings_pct) / 100.0)

    qa_settings = QaSettings(
        verify=not parsed.no_verify,
        max_size_ratio=max_size_ratio,
        quarantine_dir=str(parsed.quarantine) if parsed.quarantine else None,
    )

    converter = VideoConverter(
        toolchain,
        encode_settings,
        qa_settings,
        dry_run=parsed.dry_run,
        force=parsed.force,
    )

    results: list[ConvertResult] = []

    if input_path.is_file():
        # Single file conversion
        if parsed.output:
            out_path = parsed.output.resolve()
            if out_path.is_dir() or (not out_path.suffix and not out_path.exists()):
                stem = input_path.stem
                out_path = out_path / f"{stem}.av1.mp4"
        else:
            stem = input_path.stem
            out_path = input_path.parent / f"{stem}.av1.mp4"

        print(f"Converting: {input_path.name} -> {out_path.name}")
        res = converter.convert_file(input_path, out_path)
        results.append(res)
        print(f"    Status: {res.status.value.upper()} | Original: {res.original_size}B | Converted: {res.converted_size}B | Duration: {res.duration_sec:.2f}s | CRF: {res.crf} | Preset: {res.preset}")
        if res.error_message:
            print(f"    Detail: {res.error_message}")
            if res.status == ConvertStatus.REJECTED:
                print(f"QA Rejection: {res.error_message}", file=sys.stderr)
    else:
        # Directory recursive conversion
        out_root = parsed.output.resolve() if parsed.output else input_path
        video_files = list(InputScanner.iter_videos(input_path))
        print(f"Found {len(video_files)} candidate video file(s) in '{input_path}' (excluding .av1.mp4)")

        for idx, src in enumerate(video_files, 1):
            rel = src.relative_to(input_path)
            stem = rel.stem
            out_file = out_root / rel.parent / f"{stem}.av1.mp4"

            print(f"[{idx}/{len(video_files)}] Processing: {rel}...")
            res = converter.convert_file(src, out_file)
            results.append(res)
            print(f"    Status: {res.status.value.upper()} | Original: {res.original_size}B | Converted: {res.converted_size}B | Duration: {res.duration_sec:.2f}s | CRF: {res.crf} | Preset: {res.preset}")
            if res.error_message:
                print(f"    Detail: {res.error_message}")
                if res.status == ConvertStatus.REJECTED:
                    print(f"QA Rejection: {res.error_message}", file=sys.stderr)

    # Summary
    success_count = sum(1 for r in results if r.status == ConvertStatus.CONVERTED)
    skipped_count = sum(1 for r in results if r.status == ConvertStatus.SKIPPED)
    rejected_count = sum(1 for r in results if r.status == ConvertStatus.REJECTED)
    failed_count = sum(1 for r in results if r.status == ConvertStatus.FAILED)

    if parsed.json_summary:
        print(json.dumps([r.to_dict() for r in results], indent=2))
    else:
        print("\n" + "=" * 50)
        print(
            f"Video Conversion Complete: {success_count} converted, {skipped_count} skipped, "
            f"{rejected_count} rejected (no savings), {failed_count} failed"
        )
        print("=" * 50)

    if failed_count > 0:
        return 1
    if rejected_count > 0:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
