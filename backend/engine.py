import copy
from datetime import datetime, timezone
from collections import deque
import sys
import threading
import time

from .core import DistractionRules, MESSAGES, classify_app
from .detector import Detector, Sounds, active_window, preview_jpeg


class Engine:
    def __init__(self, window_reader=active_window, sounds=None, clock=time.monotonic):
        self.lock = threading.RLock()
        self.clock = clock
        self.window_reader = window_reader
        self.sounds = sounds or Sounds()
        self.closing = threading.Event()
        self.rules = DistractionRules()
        self.owner = None
        self.owner_until = 0
        self.owner_released = False
        self.session_details = {}
        self.session_id = None
        self.phase = 'idle'
        self.options = {'camera': False, 'appCheck': True, 'mouthCheck': True, 'mute': False,
                        'mode': 'screen', 'cameraIndex': 0, 'cameraName': '', 'allowedApps': [], 'reminderCooldown': 5}
        self.camera_state = 'off'
        self.camera_error = None
        self.camera_epoch = 0
        self.sample = None
        self.jpeg = None
        self.frame_sequence = 0
        self.latest_frame = None
        self.camera_fps = self.camera_reported_fps = self.detection_fps = 0
        self.detection_error = None
        self.frame_ready = threading.Condition(self.lock)
        self.app = classify_app('')
        self.app_error = None
        self.reason = 'checking'
        self.active = self.paused = self.remaining = 0
        self.break_remaining = 300
        self.observations = {}
        self.reminders = 0
        self.event = None
        self.event_id = 0
        self.last_alert = float('-inf')
        self.snoozed_until = 0
        self.anchor = self.clock()
        self.preview_until = 0
        self.threads = []

    def start_workers(self):
        for fn in (self._run, self._camera_loop, self._detection_loop):
            thread = threading.Thread(target=fn, daemon=True)
            thread.start()
            self.threads.append(thread)

    def close(self):
        self.closing.set()
        with self.frame_ready:
            self.frame_ready.notify_all()
        self.sounds.stop()
        for thread in self.threads:
            thread.join(timeout=3)

    def wants_camera(self):
        return self.options['camera'] and self.phase in ('focus', 'preview')

    def control(self, action, owner, data):
        with self.lock:
            now = self.clock()
            self.step(now)
            if action == 'recover':
                if not self.session_id or self.phase not in ('focus', 'paused', 'break', 'summary'):
                    raise ValueError('There is no session to recover.')
                if self.owner != owner and not self.owner_released and now < self.owner_until:
                    raise ValueError('The other tab is still connected. Pause or end the session there first.')
                self.owner = owner
                self.options['camera'] = False
                self.camera_epoch += 1
                self.event = None
                if self.phase == 'focus':
                    self.phase = 'paused'
            elif self.owner and self.owner != owner and self.phase in ('focus', 'paused', 'break', 'preview'):
                raise ValueError('Another StudyBuddy tab owns the current session. Use that tab to pause or end it.')
            if action == 'start':
                if self.phase in ('focus', 'paused', 'break') and data['sessionId'] != self.session_id:
                    raise ValueError('End the current session before starting another.')
                self.owner, self.session_id = owner, data['sessionId']
                self.active, self.paused = data.get('active', 0), data.get('paused', 0)
                self.remaining = data['remaining']
                self.session_details = {'task': data.get('task', 'Recovered session'),
                                        'duration': data.get('duration', self.active + self.remaining),
                                        'startedAt': data.get('startedAt') or datetime.now(timezone.utc).isoformat()}
                self.observations = dict(data.get('observations', {}))
                self.reminders = data.get('reminders', 0)
                self.break_remaining = 300
                self.phase = 'focus'
                self.options.update({key: data[key] for key in self.options if key in data})
                self.rules = DistractionRules()
                self.last_alert = float('-inf'); self.snoozed_until = 0; self.event = None
                self.camera_epoch += 1
            elif action == 'preview':
                self.owner = owner
                if self.phase not in ('focus', 'paused', 'break'):
                    self.phase = 'preview'
                self.options['camera'] = True
                self.options['cameraIndex'] = data.get('cameraIndex', 0)
                self.options['cameraName'] = data.get('cameraName', '')
                self.preview_until = now + 120
                self.camera_epoch += 1
            elif action in ('pause', 'release'):
                if self.phase == 'focus':
                    self.phase = 'paused'
                elif self.phase == 'preview':
                    self.phase = 'idle'
                self.sounds.stop()
                self.rules = DistractionRules()
                if action == 'release':
                    self.options['camera'] = False
                    self.camera_epoch += 1
                    self.event = None
            elif action == 'resume':
                if self.phase == 'paused':
                    self.phase = 'focus'
                    self.camera_epoch += 1
            elif action == 'end':
                self.phase = 'summary' if self.session_id else 'idle'
                self.sounds.stop()
            elif action == 'camera':
                self.options['camera'] = data['camera']
                if not data['camera'] and self.phase == 'preview':
                    self.phase = 'idle'
                if 'cameraIndex' in data:
                    self.options['cameraIndex'] = data['cameraIndex']
                    self.options['cameraName'] = data.get('cameraName', '')
                self.camera_epoch += 1
                self.rules = DistractionRules()
            elif action == 'settings':
                for key in ('mute', 'mouthCheck', 'appCheck', 'allowedApps', 'reminderCooldown'):
                    if key in data:
                        self.options[key] = data[key]
                if self.options['mute']:
                    self.sounds.stop()
            elif action == 'snooze':
                self.snoozed_until = now + 300
                self.sounds.stop()
            elif action == 'sound':
                self.sounds.play()
            if self.owner == owner:
                self.owner_released = action == 'release'
                self.owner_until = now + 120
            self.anchor = now
            return self.snapshot(owner)

    def step(self, now):
        """Advance the authoritative timer and observations without browser polling."""
        leased = self.owner is not None and self.phase in ('focus', 'paused', 'break')
        end = min(now, self.owner_until) if leased else now
        delta = 0 if leased and self.owner_released else max(0, end - self.anchor)
        self.anchor = now
        if self.phase == 'preview' and now >= self.preview_until:
            self.phase = 'idle'
        if self.phase == 'focus':
            used = min(delta, self.remaining)
            self.active += used
            self.remaining = max(0, self.remaining - used)
            kind = self.rules.evaluate(self.sample, self.app, now, camera_enabled=self.options['camera'],
                                       app_enabled=self.options['appCheck'], mode=self.options['mode'],
                                       mouth_check=self.options['mouthCheck'])
            if kind != 'checking':
                self.observations[kind] = self.observations.get(kind, 0) + min(used, 1)
            previous, self.reason = self.reason, kind
            if kind not in ('present', 'checking') and now >= self.snoozed_until:
                if now - self.last_alert >= self.options['reminderCooldown']:
                    self.last_alert = now
                    self.reminders += 1
                    self.event_id += 1
                    message = MESSAGES[kind]
                    if kind == 'distraction-app':
                        message = f"{self.app['name']} is distracting you from your task. Return when you are ready."
                    self.event = {'id': self.event_id, 'kind': kind, 'message': message}
                    if not self.options['mute']:
                        self.sounds.play()
            elif kind == 'present' and previous not in ('present', 'checking'):
                self.event_id += 1
                self.event = {'id': self.event_id, 'kind': 'returned', 'message': 'Back on track. Keep going.'}
                if not self.options['mute'] and now >= self.snoozed_until:
                    self.sounds.play(returned=True)
            if self.remaining == 0:
                self.phase = 'break'; self.break_remaining = 300; self.sounds.stop()
        elif self.phase == 'paused':
            self.paused += delta
        elif self.phase == 'break':
            self.break_remaining = max(0, self.break_remaining - delta)
            if self.break_remaining == 0:
                self.phase = 'summary'
        if leased and now >= self.owner_until and not self.owner_released:
            if self.phase == 'focus':
                self.phase = 'paused'
            self.owner_released = True
            self.options['camera'] = False
            self.camera_epoch += 1
            self.sounds.stop()

    def snapshot(self, owner):
        with self.lock:
            if self.clock() > self.anchor:
                self.step(self.clock())
            # Keep an enabled preview alive while its owning tab is connected.
            # The lease still releases a preview whose tab disappears without pagehide.
            if self.owner == owner and self.phase == 'preview':
                self.preview_until = self.clock() + 120
            if self.owner == owner and not self.owner_released:
                self.owner_until = self.clock() + 120
            # A second tab can discover a conflict without seeing titles/frames.
            if self.owner and self.owner != owner and self.phase in ('focus', 'paused', 'break', 'preview'):
                return {'busy': True, 'phase': self.phase, 'canRecover': self.owner_released}
            return copy.deepcopy({
                'busy': False, 'sessionId': self.session_id, 'phase': self.phase,
                **self.session_details, 'released': self.owner_released,
                'snoozeRemaining': max(0, self.snoozed_until - self.clock()),
                'cameraState': self.camera_state, 'cameraError': self.camera_error,
                'cameraFps': self.camera_fps, 'cameraReportedFps': self.camera_reported_fps,
                'detectionFps': self.detection_fps, 'detectionError': self.detection_error,
                'app': self.app, 'appError': self.app_error, 'sample': self.sample,
                'reason': self.reason, 'message': MESSAGES[self.reason],
                'active': self.active, 'paused': self.paused, 'remaining': self.remaining,
                'breakRemaining': self.break_remaining, 'observations': self.observations,
                'reminders': self.reminders, 'event': self.event, 'options': self.options,
                'audioError': self.sounds.error,
                'focusPercent': round(100 * self.observations.get('present', 0) / self.active, 1) if self.active else 0,
            })

    def _run(self):
        while not self.closing.wait(.2):
            with self.lock:
                active = self.phase == 'focus' and self.options['appCheck']
                allowed = self.options['allowedApps'][:]
            if active:
                try:
                    app = classify_app(self.window_reader(), allowed)
                    error = None
                except Exception:
                    app = classify_app('')
                    error = 'Active-window monitoring is unavailable on this system. Windows is supported by the original engine.'
                with self.lock:
                    self.app, self.app_error = app, error
            with self.lock:
                self.step(self.clock())

    def _camera_loop(self):
        # Capture and JPEG delivery never wait for YOLO/MediaPipe. There is only
        # one latest frame for inference, so slow models cannot build a backlog.
        capture = None
        failed_epoch = None
        camera_index = None
        opened_epoch = None
        times = deque(maxlen=90)
        try:
            while not self.closing.is_set():
                with self.lock:
                    wanted = self.wants_camera()
                    epoch = self.camera_epoch
                    index = self.options['cameraIndex']
                    label = f"'{self.options['cameraName']}'" if self.options['cameraName'] else f'camera {index}'
                if not wanted or camera_index != index or opened_epoch != epoch:
                    if capture is not None:
                        capture.release(); capture = None
                    with self.lock:
                        self.jpeg = None; self.sample = None; self.latest_frame = None
                        self.camera_fps = self.camera_reported_fps = self.detection_fps = 0
                        self.detection_error = None
                        self.camera_state = 'off'
                    times.clear()
                    if not wanted:
                        self.closing.wait(.1)
                        continue
                if failed_epoch == epoch:
                    self.closing.wait(.2)
                    continue
                try:
                    if capture is None:
                        import cv2
                        with self.lock:
                            self.camera_state = 'loading'; self.camera_error = None
                        capture = cv2.VideoCapture(index, cv2.CAP_DSHOW if sys.platform == 'win32' else cv2.CAP_ANY)
                        camera_index = index
                        opened_epoch = epoch
                        # Ask for compressed USB transport and the camera's own
                        # default FPS. Do not cap a 60 FPS camera at 30 FPS.
                        reported = capture.get(cv2.CAP_PROP_FPS)
                        capture.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*'MJPG'))
                        capture.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
                        capture.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
                        if 0 < reported <= 240:
                            capture.set(cv2.CAP_PROP_FPS, reported)
                        capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                        with self.lock:
                            self.camera_reported_fps = capture.get(cv2.CAP_PROP_FPS)
                        if not capture.isOpened():
                            raise RuntimeError(f"Couldn't open {label}. Close Zoom, Teams or other camera apps, check Windows camera permission, or choose another camera.")
                        warmup = 15  # Some webcams return no frames for a moment after opening.
                    else:
                        warmup = 1
                    for _ in range(warmup):
                        ok, frame = capture.read()
                        if ok and frame is not None:
                            break
                        self.closing.wait(.1)
                    if not ok or frame is None:
                        raise RuntimeError(f'{label[0].upper()}{label[1:]} stopped sending images. Check the connection, or choose another camera.')
                    at = self.clock()
                    with self.lock:
                        overlay = self.sample if self.sample and at - self.sample['at'] < .75 else None
                    jpeg = preview_jpeg(frame.copy(), overlay)
                    times.append(at)
                    with self.lock:
                        if self.wants_camera() and self.camera_epoch == epoch:
                            self.frame_sequence += 1
                            self.latest_frame = (self.frame_sequence, epoch, at, frame)
                            self.jpeg = jpeg
                            self.camera_fps = round((len(times) - 1) / (times[-1] - times[0]), 1) if len(times) > 1 else 0
                            self.camera_state = 'on'; self.camera_error = None
                            self.frame_ready.notify_all()
                except Exception as error:
                    if capture is not None:
                        capture.release(); capture = None
                    failed_epoch = epoch
                    with self.lock:
                        self.sample = None; self.jpeg = None; self.latest_frame = None
                        self.camera_fps = self.detection_fps = 0
                        self.camera_state = 'error'
                        self.camera_error = f'Original camera engine: {error}'
        finally:
            if capture is not None:
                capture.release()

    def _detection_loop(self):
        detector = None
        last_sequence = None
        failed_epoch = None
        try:
            while not self.closing.is_set():
                with self.frame_ready:
                    self.frame_ready.wait_for(lambda: self.closing.is_set() or (
                        self.latest_frame is not None and self.wants_camera() and
                        self.latest_frame[0] != last_sequence and self.camera_epoch != failed_epoch), timeout=.2)
                    if self.closing.is_set():
                        break
                    latest = self.latest_frame
                    if not latest or not self.wants_camera() or latest[0] == last_sequence or self.camera_epoch == failed_epoch:
                        continue
                    sequence, epoch, at, frame = latest
                    last_sequence = sequence
                try:
                    if detector is None:
                        detector = Detector()
                        # Loading models can take seconds. Take a fresh frame.
                        continue
                    started = self.clock()
                    sample = detector.analyze(frame)
                    sample.update(at=at, sequence=sequence)
                    elapsed = self.clock() - started
                    with self.lock:
                        if self.wants_camera() and self.camera_epoch == epoch and self.camera_state == 'on':
                            self.sample = sample
                            self.detection_fps = round(1 / elapsed, 1) if elapsed > 0 else 0
                            self.detection_error = None
                except Exception as error:
                    failed_epoch = epoch
                    with self.lock:
                        if self.camera_epoch == epoch:
                            self.sample = None; self.detection_fps = 0
                            self.detection_error = f'Camera preview is live, but distraction detection failed: {error}'
        finally:
            if detector is not None:
                detector.close()
