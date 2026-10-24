"""Shared constants for convert_video_to_av1."""

from __future__ import annotations

VIDEO_EXTENSIONS = frozenset({".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"})

# Audio codecs compatible with MP4 container without transcoding
MP4_COMPATIBLE_AUDIO_CODECS = frozenset({"aac", "mp3", "opus", "flac"})

DEFAULT_CRF = 28
DEFAULT_PRESET = 6
DEFAULT_THREADS = 2
DEFAULT_AUDIO_BITRATE = "192k"

INSTALL_HINT = """
Required tools (must be on PATH, or set env overrides):
  ffmpeg   with libsvtav1 encoder and dav1d/av1 decoder
  ffprobe  for media probing

Install tips (Debian/Ubuntu):
  sudo apt update && sudo apt install ffmpeg
  Verify: ffmpeg -encoders | grep libsvtav1
""".strip()
