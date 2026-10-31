import ast
from pathlib import Path
from types import SimpleNamespace as Point
import unittest
from backend.core import classify_app, DistractionRules, head_pose, mouth_open
from backend.engine import Engine


def sample(sequence, now, **changes):
    return dict(facePresent=True, direction='forward', phoneVisible=False, mouthOpen=False,
                sequence=sequence, at=now, **changes) if not changes else {
                    **sample(sequence, now), **changes}


class SilentSounds:
    error = None
    def __init__(self): self.calls = []
    def play(self, returned=False): self.calls.append('return' if returned else 'warning')
    def stop(self): pass


class CoreParity(unittest.TestCase):
    def test_preview_stays_enabled_while_owner_is_connected_and_expires_when_abandoned(self):
        now = [0]
        engine = Engine(sounds=SilentSounds(), clock=lambda: now[0])
        engine.control('preview', 'preview-owner', {})
        for at in (60, 119, 180, 240):
            now[0] = at
            engine.step(at)
            self.assertEqual(engine.snapshot('preview-owner')['phase'], 'preview')
            self.assertTrue(engine.wants_camera())
        # Polling from another tab must not keep an abandoned owner's camera open.
        now[0] = 350
        engine.snapshot('other-owner')
        now[0] = 361
        engine.step(now[0])
        self.assertFalse(engine.wants_camera())

    def test_actual_app_and_tab_names(self):
        for title in ['YouTube - Google Chrome', 'Facebook - Microsoft Edge', 'Discord', 'VALORANT', 'COD']:
            self.assertFalse(classify_app(title)['isStudy'], title)
        for title in ['Visual Studio Code', 'Microsoft Word', 'StudyBuddy', 'Chapter 4.pdf - Adobe Reader']:
            self.assertTrue(classify_app(title)['isStudy'], title)
        self.assertTrue(classify_app('YouTube - lecture', ['YouTube'])['isStudy'])
        self.assertIsNone(classify_app('Unknown')['isStudy'])

    def test_app_distraction_does_not_require_camera_or_visible_tab(self):
        rules = DistractionRules()
        app = classify_app('YouTube - Chrome')
        self.assertEqual(rules.evaluate(None, app, 0, camera_enabled=False), 'distraction-app')
        self.assertEqual(rules.evaluate(sample(1, 0), app, 0), 'distraction-app')

    def test_original_phone_confirmation_and_absence_delay(self):
        rules = DistractionRules()
        for i in range(4):
            kind = rules.evaluate(sample(i, i * .2, phoneVisible=True), {}, i * .2)
        self.assertEqual(kind, 'phone')
        rules = DistractionRules()
        self.assertEqual(rules.evaluate(sample(0, 0, facePresent=False), {}, 0), 'checking')
        self.assertEqual(rules.evaluate(sample(1, 2.1, facePresent=False), {}, 2.1), 'away')

    def test_looking_away_and_original_talking_heuristic(self):
        rules = DistractionRules()
        for i in range(20):
            kind = rules.evaluate(sample(i, i * .2, direction='left', mouthOpen=True), {}, i * .2)
        self.assertEqual(kind, 'talking')
        self.assertEqual(rules.evaluate(sample(21, 4.2, direction='left', mouthOpen=True), {}, 4.2, mode='lecture'), 'looking-away')
        rules = DistractionRules()
        for i in range(15):
            kind = rules.evaluate(sample(i, i * .2, direction='down'), {}, i * .2, mode='paper')
        self.assertEqual(kind, 'checking')

    def test_face_math_matches_original_python_functions(self):
        source = ast.parse(Path('study_monitor.py').read_text(encoding='utf-8-sig'))
        functions = [n for n in source.body if isinstance(n, ast.FunctionDef) and n.name in ('check_head_pose', 'detect_mouth_open')]
        scope = {}
        exec(compile(ast.Module(body=functions, type_ignores=[]), '<original isolated functions>', 'exec'), scope)
        points = [Point(x=.5, y=.5) for _ in range(468)]
        points[33] = Point(x=.3, y=.35); points[263] = Point(x=.7, y=.35)
        points[133] = Point(x=.4, y=.35); points[362] = Point(x=.6, y=.35)
        points[61] = Point(x=.4, y=.6); points[291] = Point(x=.6, y=.6)
        points[13] = Point(x=.5, y=.58); points[14] = Point(x=.5, y=.66)
        for x, y in ((.5, .45), (.7, .45), (.3, .45), (.5, .7)):
            points[1] = Point(x=x, y=y)
            original = Point(landmark=points)
            self.assertEqual(head_pose(points), scope['check_head_pose'](original, 640, 480)[1])
            self.assertEqual(mouth_open(points), scope['detect_mouth_open'](original)[0])

    def test_server_accumulates_distraction_and_sounds_without_web_requests(self):
        sounds = SilentSounds()
        engine = Engine(sounds=sounds, clock=lambda: 0)
        engine.control('start', 'test-owner', dict(sessionId='test-session', remaining=25, camera=False, appCheck=True, mute=False))
        engine.app = classify_app('YouTube - Chrome')
        for i in range(1, 61): engine.step(i * .2)
        state = engine.snapshot('test-owner')
        self.assertAlmostEqual(state['observations']['distraction-app'], 12)
        self.assertGreaterEqual(state['reminders'], 2)
        self.assertEqual(sounds.calls[0], 'warning')
        engine.app = classify_app('Visual Studio Code')
        engine.step(12.2)
        self.assertEqual(sounds.calls[-1], 'return')
        self.assertEqual(engine.reason, 'present')

    def test_pause_snooze_and_final_statistics(self):
        now = [0]
        sounds = SilentSounds()
        engine = Engine(sounds=sounds, clock=lambda: now[0])
        engine.control('start', 'test-owner', dict(sessionId='test-session', remaining=60, camera=False, appCheck=True, mute=False))
        engine.app = classify_app('Netflix')
        now[0] = 1; engine.step(now[0])
        engine.control('snooze', 'test-owner', {})
        now[0] = 10; engine.step(now[0])
        self.assertEqual(len(sounds.calls), 1)
        engine.control('pause', 'test-owner', {})
        now[0] = 30; engine.control('end', 'test-owner', {})
        self.assertEqual(engine.active, 10)
        self.assertEqual(engine.paused, 20)


if __name__ == '__main__': unittest.main()
