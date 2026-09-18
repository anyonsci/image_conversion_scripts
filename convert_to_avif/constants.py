"""Shared constants."""

from __future__ import annotations

IMAGE_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".webp"})

# ISO Ultra HDR / Adobe gain map and Apple HDR gain map XMP markers
GAINMAP_MARKERS = (
    b"hdrgm:Version",
    b"hdrgm:version",
    b"http://ns.adobe.com/hdr-gain-map/",
    b"HDRGainMapVersion",
    b"HDRGainMap:HDRGainMapVersion",
    b"http://ns.apple.com/HDRGainMap/",
)

EXIF_HINT_KEYS = ("DateTimeOriginal", "Orientation", "Make", "ExifByteOrder")
ICC_HINT_KEYS = ("ProfileDescription", "ICC_Profile", "ColorSpace")
GAINMAP_META_HINTS = ("GainMap", "hdrgm", "UltraHDR")

# Valid 8x8 JPEG used only to probe whether avifenc has an encode codec.
PROBE_JPEG_B64 = (
    "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjIzLjEwMwD/2wBDAAgKCgsKCw0NDQ0NDRA"
    "PEBAQEBAQEBAQEBASEhIVFRUSEhIQEBISFBQVFRcXFxUVFRUXFxkZGR4eHBwjIyQrKzP/xABMAA"
    "EBAAAAAAAAAAAAAAAAAAAABgEBAQAAAAAAAAAAAAAAAAAABgcQAQAAAAAAAAAAAAAAAAAAAAAR"
    "AQAAAAAAAAAAAAAAAAAAAAD/wAARCAAIAAgDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCLAE1/f//Z"
)

INSTALL_HINT = """
Required tools (must be on PATH, or set env overrides):
  AVIFENC / avifenc          libavif encoder WITH an AV1 encode codec
                             (libaom and/or SVT-AV1 linked at build time)
  AVIFDEC / avifdec          libavif decoder (for QA)
  AVIFGAINMAPUTIL (optional) verify / HDR tonemap helpers
  EXIFTOOL (optional)        metadata checks / fallback
  DSSIM or FFMPEG (optional) perceptual --verify

Install tips:
  • exiftool:  apt install libimage-exiftool-perl  |  brew install exiftool
  • dssim:     cargo install dssim  |  brew install dssim
  • libavif apps (avifenc/avifdec/avifgainmaputil) ≥ 1.2 / ideally 1.3+:
      Enable at least one encode codec when building, e.g.:
        cmake -DAVIF_BUILD_APPS=ON -DAVIF_CODEC_AOM=SYSTEM ...
      or -DAVIF_CODEC_SVT=SYSTEM
      Also enable JPEG + libxml2 so Ultra HDR gain maps can be read.
      Confirm: `avifenc --version` lists an encoder (aom/svt), and
      `avifenc -h` mentions --qgain-map for gain-map support.
""".strip()
