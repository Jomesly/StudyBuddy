import unittest
from fastapi.testclient import TestClient
from backend import server
from backend.engine import Engine
from backend.core import classify_app
from test_core import SilentSounds


class APIIntegration(unittest.TestCase):
    def setUp(self):
        self.original = server.engine
        self.now = [0]
        server.engine = Engine(sounds=SilentSounds(), clock=lambda: self.now[0])
        self.client = TestClient(server.app)
        key = self.client.get('/api/health').json()['key']
        self.headers = {'X-StudyBuddy-Key': key, 'X-StudyBuddy-Client': 'test-browser'}

    def tearDown(self):
        self.client.close(); server.engine = self.original

    def test_local_api_exposes_actual_distraction_and_final_stats(self):
        response = self.client.post('/api/control', headers=self.headers, json={'action': 'start', 'sessionId': 'session-1', 'camera': False, 'remaining': 30})
        self.assertEqual(response.status_code, 200)
        server.engine.app = classify_app('YouTube - Google Chrome')
        for i in range(1, 31): self.now[0] = i * .2; server.engine.step(self.now[0])
        state = self.client.get('/api/state', headers=self.headers).json()
        self.assertEqual(state['reason'], 'distraction-app')
        self.assertIn('YouTube', state['app']['title'])
        self.assertGreater(state['observations']['distraction-app'], 5)
        self.assertGreater(state['reminders'], 0)
        final = self.client.post('/api/control', headers=self.headers, json={'action': 'end'}).json()
        self.assertEqual(final['phase'], 'summary')
        self.assertAlmostEqual(final['active'], 6)

    def test_unauthorized_origins_and_conflicting_tabs_cannot_control_camera(self):
        self.assertEqual(self.client.post('/api/control', json={'action': 'preview'}).status_code, 403)
        self.assertEqual(self.client.get('/api/health', headers={'Origin': 'https://unrelated.example'}).status_code, 403)
        self.client.post('/api/control', headers=self.headers, json={'action': 'start', 'sessionId': 'session-1', 'camera': False})
        other = {**self.headers, 'X-StudyBuddy-Client': 'other-browser'}
        self.assertEqual(self.client.post('/api/control', headers=other, json={'action': 'end'}).status_code, 409)
        self.assertEqual(self.client.get('/api/state', headers=other).json()['busy'], True)
        self.assertEqual(self.client.get('/api/stream', headers=other).status_code, 403)
        self.assertEqual(self.client.get('/api/stream').status_code, 403)


if __name__ == '__main__': unittest.main()
