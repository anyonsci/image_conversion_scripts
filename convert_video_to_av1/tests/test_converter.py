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

        # Generate a small 1-second test MP4 (H264 + AAC, high quality source ~60KB)
        cls.mp4_src = cls.work_dir / "sample.mp4"
        subprocess.run(
            [
                cls.tools.ffmpeg_bin, "-y",
                "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=15",
                "-f", "lavfi", "-i", "sine=frequency=800:duration=1",
                "-c:v", "libx264", "-crf", "15", "-c:a", "aac",
                str(cls.mp4_src),
            ],
            capture_output=True,
            check=True,
        )

        # Generate a small 1-second test MOV (H264 + PCM audio, high quality source)
        cls.mov_src = cls.work_dir / "sample.mov"
        subprocess.run(
            [
                cls.tools.ffmpeg_bin, "-y",
                "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=15",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
                "-c:v", "libx264", "-crf", "15", "-c:a", "pcm_s16le",
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

        # 1. 4K high density test -> crf should scale up to top of range (36)
        info_4k = VideoInfo(
            path="dummy.mp4", duration=10.0, width=3840, height=2160, fps=30.0,
            video_codec="h264", audio_codec="aac", pix_fmt="yuv420p", bit_depth=8,
            is_hdr=False, size_bytes=100_000_000
        )
        crf_4k, reason_4k = compute_adaptive_video_crf(info_4k, 30)
        self.assertEqual(crf_4k, 36)

        # 2. 4K 60fps HDR HEVC test -> scales up to 36 (4K + 60fps + HEVC efficiency)
        info_4k_60_hdr = VideoInfo(
            path="dummy4k60.mov", duration=5.8, width=3840, height=2160, fps=60.0,
            video_codec="hevc", audio_codec="aac", pix_fmt="yuv420p10le", bit_depth=10,
            is_hdr=True, size_bytes=20_000_000
        )
        crf_4k_60, reason_4k_60 = compute_adaptive_video_crf(info_4k_60_hdr, 30)
        self.assertEqual(crf_4k_60, 36)

        # 3. 1080p high-bitrate camera original -> crf should scale to 33
        info_1080p_high = VideoInfo(
            path="camera.mp4", duration=7.9, width=1920, height=1080, fps=30.0,
            video_codec="h264", audio_codec="aac", pix_fmt="yuv420p", bit_depth=8,
            is_hdr=False, size_bytes=18_300_000  # ~18.5 Mbps, BPPF ~0.298
        )
        crf_1080p, reason_1080p = compute_adaptive_video_crf(info_1080p_high, 30)
        self.assertEqual(crf_1080p, 33)

        # 4. 1080p 10-bit HDR video -> capped at 33 for banding protection
        info_hdr = VideoInfo(
            path="hdr.mp4", duration=6.0, width=1920, height=1080, fps=30.0,
            video_codec="hevc", audio_codec="aac", pix_fmt="yuv420p10le", bit_depth=10,
            is_hdr=True, size_bytes=17_000_000
        )
        crf_hdr, reason_hdr = compute_adaptive_video_crf(info_hdr, 30)
        self.assertEqual(crf_hdr, 33)

        # 5. 720p or lower standard test -> floor at 30
        info_720 = VideoInfo(
            path="dummy.mp4", duration=10.0, width=1280, height=720, fps=30.0,
            video_codec="h264", audio_codec="aac", pix_fmt="yuv420p", bit_depth=8,
            is_hdr=False, size_bytes=5_000_000
        )
        crf_720, reason_720 = compute_adaptive_video_crf(info_720, 30)
        self.assertEqual(crf_720, 30)

    def test_skip_low_bitrate_whatsapp_video(self):
        # Create a small, low-bitrate synthetic video (simulating WhatsApp 400 kbps clip)
        low_br_src = self.work_dir / "whatsapp_sample.mp4"
        subprocess.run(
            [
                self.tools.ffmpeg_bin, "-y",
                "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=15",
                "-c:v", "libx264", "-b:v", "30k", "-maxrate", "40k", "-bufsize", "80k",
                str(low_br_src),
            ],
            capture_output=True,
            check=True,
        )

        # By default (skip_low_bitrate=True), it should skip to prevent generation loss
        encode_settings = EncodeSettings(skip_low_bitrate=True)
        qa_settings = QaSettings(verify=False)
        converter = VideoConverter(self.tools, encode_settings, qa_settings)

        out_path = self.work_dir / "whatsapp_sample.av1.mp4"
        res = converter.convert_file(low_br_src, out_path)

        self.assertEqual(res.status, ConvertStatus.SKIPPED)
        self.assertIn("already highly compressed", res.error_message)
        self.assertFalse(out_path.exists())

    def test_metadata_preservation(self):
        # Create a small 0.5-second test video with embedded creation_time and location tags
        meta_src = self.work_dir / "meta_source.mp4"
        subprocess.run(
            [
                self.tools.ffmpeg_bin, "-y",
                "-f", "lavfi", "-i", "testsrc=duration=0.5:size=320x240:rate=15",
                "-metadata", "creation_time=2024-10-12T09:36:04.000000Z",
                "-metadata", "location=+34.0552+074.3837/",
                "-c:v", "libx264", "-crf", "15",
                str(meta_src),
            ],
            capture_output=True,
            check=True,
        )

        encode_settings = EncodeSettings(crf=32, preset=8, threads=1)
        qa_settings = QaSettings(verify=False)
        converter = VideoConverter(self.tools, encode_settings, qa_settings)

        meta_out = self.work_dir / "meta_output.av1.mp4"
        res = converter.convert_file(meta_src, meta_out)

        self.assertEqual(res.status, ConvertStatus.CONVERTED)
        self.assertTrue(meta_out.exists())

        # Verify creation_time is preserved in AV1 output
        prober = VideoProber(self.tools)
        out_info = prober.probe(meta_out)
        self.assertEqual(out_info.creation_time, "2024-10-12T09:36:04.000000Z")

    def test_qa_rejects_insufficient_savings(self):
        # When required savings is impossible (e.g. max_size_ratio=0.0001, requiring 99.99% savings),
        # QA must reject the output and return REJECTED status
        encode_settings = EncodeSettings(crf=28, preset=8, threads=1)
        qa_settings = QaSettings(verify=True, max_size_ratio=0.0001)
        converter = VideoConverter(self.tools, encode_settings, qa_settings)

        out_path = self.work_dir / "sample_rejected.av1.mp4"
        res = converter.convert_file(self.mp4_src, out_path)

        self.assertEqual(res.status, ConvertStatus.REJECTED)
        self.assertFalse(res.qa_passed)
        self.assertIn("Insufficient compression", res.error_message)
        # Verify output file was cleaned up on rejection
        self.assertFalse(out_path.exists())

    def test_capped_crf_mbr(self):
        from convert_video_to_av1.encoding import VideoEncoder
        from convert_video_to_av1.models import EncodeSettings, VideoInfo
        from pathlib import Path

        # 10 Mbps source video -> 90% cap = 9000 kbps
        info = VideoInfo(
            path="source.mp4", duration=10.0, width=1920, height=1080, fps=30.0,
            video_codec="h264", audio_codec="aac", pix_fmt="yuv420p", bit_depth=8,
            is_hdr=False, size_bytes=12_500_000  # 10,000,000 bps = 10,000 kbps
        )
        encoder = VideoEncoder(self.tools, EncodeSettings(crf=30, preset=8, threads=2))
        cmd = encoder.build_ffmpeg_cmd(info, Path("out.av1.mp4"))

        # Verify svtav1-params contains mbr=9000
        svt_idx = cmd.index("-svtav1-params")
        svt_params = cmd[svt_idx + 1]
        self.assertIn("mbr=9000", svt_params)
        self.assertIn("lp=2", svt_params)


if __name__ == "__main__":
    unittest.main()
