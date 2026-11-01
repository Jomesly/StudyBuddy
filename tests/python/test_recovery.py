import unittest
from backend.core import classify_app
from backend.engine import Engine
from test_core import SilentSounds


class SessionRecovery(unittest.TestCase):
    def setUp(self):
        self.now = 0
        self.engine = Engine(sounds=SilentSounds(), clock=lambda: self.now)
        self.engine.control('start', 'original-owner', {
            'sessionId': 'saved-session', 'task': 'Chapter four', 'duration': 1500,
            'remaining': 1500, 'camera': True, 'appCheck': False})

    def test_live_owner_cannot_be_stolen_and_observers_cannot_renew_lease(self):
        self.now = 60
        state = self.engine.snapshot('new-owner')
        self.assertEqual(state, {'busy': True, 'phase': 'focus', 'canRecover': False})
        with self.assertRaises(ValueError):
            self.engine.control('recover', 'new-owner', {})
        self.now = 121
        self.assertTrue(self.engine.snapshot('new-owner')['canRecover'])
        state = self.engine.control('recover', 'new-owner', {})
        self.assertEqual(state['active'], 120)
        self.assertEqual(state['remaining'], 1380)
        self.assertEqual(state['task'], 'Chapter four')
        self.assertEqual(state['phase'], 'paused')
        self.assertFalse(state['options']['camera'])
        self.assertFalse(self.engine.wants_camera())
        with self.assertRaises(ValueError):
            self.engine.control('resume', 'original-owner', {})

    def test_explicit_release_preserves_progress_and_freezes_abandoned_pause(self):
        self.now = 10
        self.engine.control('release', 'original-owner', {})
        self.now = 86400
        self.assertTrue(self.engine.snapshot('new-owner')['canRecover'])
        recovered = self.engine.control('recover', 'new-owner', {})
        self.assertEqual(recovered['active'], 10)
        self.assertEqual(recovered['paused'], 0)
        self.assertFalse(recovered['options']['camera'])
        self.engine.control('resume', 'new-owner', {})
        self.now += 5
        self.assertEqual(self.engine.snapshot('new-owner')['active'], 15)

    def test_owner_heartbeat_keeps_background_session_alive(self):
        for self.now in (60, 119, 180, 240):
            state = self.engine.snapshot('original-owner')
            self.assertEqual(state['phase'], 'focus')
            self.assertFalse(state['released'])
        self.assertEqual(state['active'], 240)

    def test_reminder_interval_applies_across_reason_changes_and_snooze_counts_down(self):
        self.engine.control('settings', 'original-owner', {'camera': False, 'appCheck': True, 'reminderCooldown': 30})
        self.engine.app = classify_app('YouTube - Chrome')
        self.now = 1
        self.engine.snapshot('original-owner')
        self.assertEqual(self.engine.reminders, 1)
        self.engine.app = classify_app('Visual Studio Code')
        self.now = 2
        self.engine.snapshot('original-owner')
        self.engine.app = classify_app('Netflix')
        self.now = 3
        self.engine.snapshot('original-owner')
        self.assertEqual(self.engine.reminders, 1)
        self.now = 31
        self.assertEqual(self.engine.snapshot('original-owner')['reminders'], 2)
        self.assertEqual(self.engine.control('snooze', 'original-owner', {})['snoozeRemaining'], 300)
        self.now = 61
        state = self.engine.snapshot('original-owner')
        self.assertEqual(state['snoozeRemaining'], 270)
        self.assertEqual(state['reminders'], 2)
