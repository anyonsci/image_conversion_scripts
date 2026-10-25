# convert_video_to_av1

A high-performance, quality-preserving Python AV1 video encoding and verification engine using `ffmpeg` and **SVT-AV1** (`libsvtav1`).

---

## 🌟 Key Features

1. **Adaptive Quality Scaling (Dynamic CRF `[30, 36]`)**:
   - Automatically tunes CRF based on resolution, framerate, source codec, and bits-per-pixel-frame (BPPF).
   - **4K UHD**: Scales base CRF by +4 (targeting CRF 34–36) where human eye acuity per pixel is highest.
   - **60 FPS**: +1 CRF to account for temporal density.
   - **Source HEVC**: +1 CRF if source is already compressed with modern H.265.
   - **Short Micro-Clips (< 5s)**: +1 CRF to counteract container overhead.
2. **Capped CRF Bitrate Ceiling (`mbr`)**:
   - High-entropy, noisy scenes (blizzards, snowstorms, waterfalls) can bloat AV1 file size under pure CRF mode.
   - Passes `mbr = int(source_bitrate * 0.90 / 1000)` into SVT-AV1 parameters, strictly guaranteeing the output video never exceeds 90% of the original file size.
3. **Preset 10 Acceleration for 4K UHD**:
   - Employs SVT-AV1 Preset 10 on 4K content to achieve 5x–8x encoding throughput acceleration while retaining high perceptual detail.
4. **HDR 10-bit Color Preservation**:
   - Preserves 10-bit depth (`yuv420p10le`), BT.2020 color primaries, and HDR transfer characteristics (SMPTE 2084 / PQ, HLG).
5. **Lossless Null-Sink Decode QA**:
   - Decodes the entire converted stream through `ffmpeg -v error -i <file> -f null -` to verify zero corrupt macroblocks, packet loss, or truncated bitstreams.
   - Verifies duration parity ($\le 0.5$s tolerance) and minimum compression savings.
   - If QA fails or savings are insufficient, exits cleanly with code `2` to preserve the source original.

---

## 📋 System Requirements

- **Python 3.10+** (Standard library only; no extra pip packages required)
- **`ffmpeg`** compiled with `libsvtav1`
- **`ffprobe`**

Check SVT-AV1 availability:
```bash
ffmpeg -encoders 2>/dev/null | grep libsvtav1
```

---

## 🚀 CLI Usage

### Shell Wrapper
```bash
# Convert a single video:
./convert_video_to_av1/convert_video_to_av1.sh input.mov -o output.mp4 -crf 30 -p 8

# Batch convert an entire folder recursively:
./convert_video_to_av1/convert_video_to_av1.sh /path/to/videos -crf 30 -p 8
```

### Python Module
```bash
# Single file conversion:
python3 -m convert_video_to_av1 input.mp4 -o output.mp4 --crf 30 --preset 8

# Recursive batch conversion with log file:
python3 -m convert_video_to_av1 /path/to/videos -crf 30 --preset 8 --log-file conversion.log
```

---

## ⚙️ CLI Options

| Option | Description | Default |
| :--- | :--- | :--- |
| `input_path` | Input video file or folder | *(Required)* |
| `-o, --output` | Output file path (single file) or directory (batch) | None |
| `-crf, --crf <int>` | Base AV1 Constant Rate Factor (`30-36`) | `30` |
| `-p, --preset <int>` | SVT-AV1 preset `0-13` (higher = faster) | `8` |
| `-t, --threads <int>` | Worker threads for SVT-AV1 | `2` |
| `--audio-codec <codec>` | `auto`, `copy`, `aac`, `opus` | `auto` |
| `--audio-bitrate <rate>`| Audio bitrate when re-encoding (e.g. `192k`) | `192k` |
| `--min-savings-pct <pct>`| Minimum required file size reduction % | `5.0` |
| `--adaptive-quality` | Dynamically tune CRF and preset | `True` |
| `--no-adaptive-quality` | Disable adaptive quality; lock to `-crf` | `False` |
| `--skip-low-bitrate` | Skip pre-compressed clips (< 1.2 Mbps) | `True` |
| `--no-verify` | Skip post-encode QA decode test | `False` |
| `-f, --force` | Overwrite output file if it already exists | `False` |
| `--log-file <path>` | Append detailed JSON/text logs to file | None |

---

## 🧪 Unit Tests

Run the test suite:
```bash
python3 -m unittest discover -s convert_video_to_av1/tests
```
