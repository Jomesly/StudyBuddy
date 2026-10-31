import unittest
from fastapi.testclient import TestClient
from backend import server
from backend.cameras import list_cameras
from backend.engine import Engine
from test_core import SilentSounds


class CameraDiscovery(unittest.TestCase):
    def test_names_keep_directshow_order_and_disambiguate_duplicates(self):
        found = list_cameras(names=lambda: ['ASUS FHD webcam', 'OBS Virtual Camera', 'USB Camera', 'USB Camera', ''])
        self.assertEqual(found['source'], 'directshow')
        self.assertEqual([c['index'] for c in found['cameras']], [0, 1, 2, 3, 4])
        self.assertEqual([c['name'] for c in found['cameras']],
                         ['ASUS FHD webcam', 'OBS Virtual Camera', 'USB Camera', 'USB Camera (2)', 'Camera 4'])
        self.assertEqual([c['virtual'] for c in found['cameras']], [False, True, False, False, False])

    def test_without_names_falls_back_to_numbered_probe_that_skips_the_busy_camera(self):
        probed = []
        def prober(busy):
            probed.append(busy)
            return [0, 2]
        found = list_cameras(busy=0, names=lambda: None, prober=prober)
        self.assertEqual(found, {'source': 'probe', 'cameras': [
            {'index': 0, 'name': 'Camera 0', 'virtual': False}, {'index': 2, 'name': 'Camera 2', 'virtual': False}]})
        self.assertEqual(probed, [0])


class CameraAPI(unittest.TestCase):
    def setUp(self):
        self.original = server.engine, server.camera_names
        server.engine = Engine(sounds=SilentSounds(), clock=lambda: 0)
        server.camera_names = lambda: ['ASUS FHD webcam', 'OBS Virtual Camera']
        self.client = TestClient(server.app)
        key = self.client.get('/api/health').json()['key']
        self.headers = {'X-StudyBuddy-Key': key, 'X-StudyBuddy-Client': 'test-browser'}

    def tearDown(self):
        self.client.close(); server.engine, server.camera_names = self.original

    def test_camera_list_requires_the_local_key(self):
        self.assertEqual(self.client.get('/api/cameras').status_code, 403)
        body = self.client.get('/api/cameras', headers=self.headers).json()
        self.assertEqual([c['name'] for c in body['cameras']], ['ASUS FHD webcam', 'OBS Virtual Camera'])
        self.assertEqual(body['selected'], 0)

    def test_selected_camera_and_name_reach_the_engine(self):
        state = self.client.post('/api/control', headers=self.headers, json={
            'action': 'preview', 'camera': True, 'cameraIndex': 1, 'cameraName': 'OBS Virtual Camera'}).json()
        self.assertEqual(state['options']['cameraIndex'], 1)
        self.assertEqual(server.engine.options['cameraName'], 'OBS Virtual Camera')

    def test_disconnected_camera_is_rejected_with_a_clear_message(self):
        response = self.client.post('/api/control', headers=self.headers, json={'action': 'preview', 'camera': True, 'cameraIndex': 3})
        self.assertEqual(response.status_code, 409)
        self.assertIn("Camera 3 isn't connected", response.json()['detail'])
        # A camera-free session never depends on a camera being present.
        ok = self.client.post('/api/control', headers=self.headers, json={'action': 'start', 'sessionId': 's1', 'camera': False, 'cameraIndex': 3})
        self.assertEqual(ok.status_code, 200)
