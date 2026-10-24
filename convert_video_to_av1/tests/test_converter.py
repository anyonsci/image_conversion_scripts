"""Unit and integration tests for convert_video_to_av1."""

import subprocess
import tempfile
import unittest
from pathlib import Path

from convert_video_to_av1.models import ConvertStatus, EncodeSettings, QaSettings
from convert_video_to_av1.pipeline import VideoConverter
from convert_video_to_av1.probing import VideoProber
from convert_video_to_av1.toolchain import Toolchain


class TestVideoConverter(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tools = Toolchain.detect()
        cls.temp_dir = tempfile.TemporaryDirectory()
        cls.work_dir = Path(cls.temp_dir.name)

        # Generate a small 1-second test MP4 (H264 + AAC)
        cls.mp4_src = cls.work_dir / "sample.mp4"
        subprocess.run(
            [
                cls.tools.ffmpeg_bin, "-y",
                "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=15",
                "-f", "lavfi", "-i", "sine=frequency=800:duration=1",
                "-c:v", "libx264", "-c:a", "aac",
                str(cls.mp4_src),
            ],
            capture_output=True,
            check=True,
        )

        # Generate a small 1-second test MOV (H264 + PCM audio)
        cls.mov_src = cls.work_dir / "sample.mov"
        subprocess.run(
            [
                cls.tools.ffmpeg_bin, "-y",
                "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=15",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
                "-c:v", "libx264", "-c:a", "pcm_s16le",
                str(cls.mov_src),
            ],
            capture_output=True,
            check=True,
        )

    @classmethod
    def tearDownClass(cls):
        cls.temp_dir.cleanup()

    def test_probing_mp4(self):
        prober = VideoProber(self.tools)
        info = prober.probe(self.mp4_src)
        self.assertEqual(info.width, 320)
        self.assertEqual(info.height, 240)
        self.assertEqual(info.video_codec, "h264")
        self.assertEqual(info.audio_codec, "aac")
        self.assertFalse(info.is_av1)

    def test_probing_mov(self):
        prober = VideoProber(self.tools)
        info = prober.probe(self.mov_src)
        self.assertEqual(info.width, 320)
        self.assertEqual(info.height, 240)
        self.assertEqual(info.video_codec, "h264")
        self.assertIn("pcm", info.audio_codec.lower())

    def test_convert_mp4_to_av1(self):
        encode_settings = EncodeSettings(crf=32, preset=8, threads=1)
        qa_settings = QaSettings(verify=True)
        converter = VideoConverter(self.tools, encode_settings, qa_settings)

        out_path = self.work_dir / "sample.av1.mp4"
        res = converter.convert_file(self.mp4_src, out_path)

        self.assertEqual(res.status, ConvertStatus.CONVERTED)
        self.assertTrue(out_path.exists())
        self.assertTrue(res.qa_passed)

        # Verify output is AV1
        prober = VideoProber(self.tools)
        out_info = prober.probe(out_path)
        self.assertTrue(out_info.is_av1)
        self.assertEqual(out_info.audio_codec, "aac")

    def test_convert_mov_with_pcm_to_av1_mp4(self):
        # PCM audio should automatically be transcoded to AAC for MP4 container compatibility
        encode_settings = EncodeSettings(crf=32, preset=8, threads=1)
        qa_settings = QaSettings(verify=True)
        converter = VideoConverter(self.tools, encode_settings, qa_settings)

        out_path = self.work_dir / "sample_mov.av1.mp4"
        res = converter.convert_file(self.mov_src, out_path)

        self.assertEqual(res.status, ConvertStatus.CONVERTED)
        self.assertTrue(out_path.exists())
        self.assertTrue(res.qa_passed)

        # Verify output is AV1 with AAC audio
        prober = VideoProber(self.tools)
        out_info = prober.probe(out_path)
        self.assertTrue(out_info.is_av1)
        self.assertEqual(out_info.audio_codec, "aac")

        # Verify attempting to convert an already .av1.mp4 file skips immediately
        skip_res = converter.convert_file(out_path, self.work_dir / "another.av1.mp4")
        self.assertEqual(skip_res.status, ConvertStatus.SKIPPED)
        self.assertIn(".av1.mp4", skip_res.error_message)

    def test_adaptive_crf(self):
        from convert_video_to_av1.encoding import compute_adaptive_video_crf
        from convert_video_to_av1.models import VideoInfo

        # 4K high density test -> crf should be scaled up (+2)
        info_4k = VideoInfo(
            path="dummy.mp4", duration=10.0, width=3840, height=2160, fps=30.0,
            video_codec="h264", audio_codec="aac", pix_fmt="yuv420p", bit_depth=8,
            is_hdr=False, size_bytes=100_000_000
        )
        crf_4k, reason_4k = compute_adaptive_video_crf(info_4k, 28)
        self.assertEqual(crf_4k, 30)

        # 720p or lower test -> crf should be scaled down (-2)
        info_720 = VideoInfo(
            path="dummy.mp4", duration=10.0, width=1280, height=720, fps=30.0,
            video_codec="h264", audio_codec="aac", pix_fmt="yuv420p", bit_depth=8,
            is_hdr=False, size_bytes=5_000_000
        )
        crf_720, reason_720 = compute_adaptive_video_crf(info_720, 28)
        self.assertEqual(crf_720, 26)


if __name__ == "__main__":
    unittest.main()
