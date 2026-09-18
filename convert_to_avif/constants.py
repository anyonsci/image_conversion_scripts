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

# Valid 64x64 PNG used only to probe whether avifenc has an SVT-AV1 encoder.
# SVT-AV1 versions before 3.0 reject dimensions smaller than 64x64.
PROBE_IMAGE_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAS0lEQVR42u3PMQ0AAAwDoEqv9ErY"
    "vQQckD4XAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAYHLAB"
    "8+AWnmfUycAAAAAElFTkSuQmCC"
)

INSTALL_HINT = """
Required tools (must be on PATH, or set env overrides):
  AVIFENC / avifenc          libavif encoder with SVT-AV1 linked at build time
  AVIFDEC / avifdec          libavif decoder (for QA)
  AVIFGAINMAPUTIL (optional) verify / HDR tonemap helpers
  EXIFTOOL (optional)        metadata checks / fallback
  DSSIM or FFMPEG (optional) perceptual --verify

Install tips:
  • exiftool:  apt install libimage-exiftool-perl  |  brew install exiftool
  • dssim:     cargo install dssim  |  brew install dssim
  • libavif apps (avifenc/avifdec/avifgainmaputil) ≥ 1.2 / ideally 1.3+:
      Build with SVT-AV1 encoding and a decoder, e.g.:
        cmake -DAVIF_BUILD_APPS=ON -DAVIF_CODEC_SVT=SYSTEM \\
              -DAVIF_CODEC_DAV1D=SYSTEM ...
      Also enable JPEG + libxml2 so Ultra HDR gain maps can be read.
      Confirm: `avifenc --version` lists svt, and
      `avifenc --codec svt input.jpg output.avif` succeeds, and
      `avifenc -h` mentions --qgain-map for gain-map support.
""".strip()
