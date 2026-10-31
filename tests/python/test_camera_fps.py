"""A slow model must not reduce the camera preview's capture rate."""
import asyncio
import struct
import time
import unittest
from unittest.mock import patch

import numpy as np

from backend.engine import Engine
from backend.server import preview_frames
from test_core import SilentSounds


class PreviewThroughput(unittest.TestCase):
    def test_preview_keeps_camera_rate_while_detection_is_slow(self):
        class Camera:
            reads = 0
            released = False
            def __init__(self, *args): pass
            def set(self, *args): pass
            def get(self, *args): return 30
            def isOpened(self): return True
            def read(self):
                time.sleep(1 / 30)
                self.reads += 1
                return True, np.full((48, 64, 3), self.reads % 255, dtype=np.uint8)
            def release(self): self.released = True

        class SlowDetector:
            calls = 0
            def analyze(self, frame):
                self.calls += 1
                time.sleep(.2)
                return {'facePresent': True, 'direction': 'forward', 'mouthOpen': False,
                        'phoneVisible': False, 'phones': [], 'faces': [], 'hands': []}
            def close(self): pass

        camera, detector = Camera(), SlowDetector()
        engine = Engine(sounds=SilentSounds())
        engine.control('preview', 'fps-test-owner', {})
        with patch('backend.engine.Detector', return_value=detector), patch('cv2.VideoCapture', return_value=camera):
            engine.start_workers()
            try:
                time.sleep(1.3)
                self.assertGreaterEqual(camera.reads, 28, '30 FPS camera was throttled by slow inference')
                self.assertGreater(detector.calls, 0, 'Distraction detection must still run')
                self.assertLess(detector.calls, camera.reads / 2)
                self.assertIsNotNone(engine.jpeg)
                self.assertIsNotNone(engine.sample)
                self.assertIsNone(engine.detection_error)
                self.assertGreater(engine.camera_fps, 24)
            finally:
                engine.close()
        self.assertTrue(camera.released)

    def test_stream_delivers_newest_frame_and_stops_when_camera_is_disabled(self):
        async def check():
            engine = Engine(sounds=SilentSounds())
            engine.control('preview', 'fps-test-owner', {})
            engine.jpeg = b'first'; engine.frame_sequence = 1
            frames = preview_frames(engine, 'fps-test-owner', engine.camera_epoch)
            self.assertEqual(await anext(frames), struct.pack('!I', 5) + b'first')
            # Several frames arrived while the network consumer was busy.
            engine.jpeg = b'latest'; engine.frame_sequence = 8
            self.assertEqual(await anext(frames), struct.pack('!I', 6) + b'latest')
            engine.control('camera', 'fps-test-owner', {'camera': False})
            self.assertEqual(engine.phase, 'idle')
            self.assertFalse(engine.snapshot('another-browser')['busy'])
            with self.assertRaises(StopAsyncIteration): await anext(frames)
        asyncio.run(check())


if __name__ == '__main__': unittest.main()
