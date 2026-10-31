"""The original YOLOv8 + MediaPipe detectors, without the OpenCV desktop UI."""
import os
from pathlib import Path
from .core import head_pose, mouth_open

ROOT = Path(__file__).resolve().parent.parent


class Detector:
    def __init__(self):
        import cv2
        import mediapipe as mp
        from ultralytics import YOLO
        self.cv2 = cv2
        self.yolo = YOLO(str(ROOT / 'yolov8n.pt'))
        self.face = mp.solutions.face_detection.FaceDetection(min_detection_confidence=.5)
        self.mesh = mp.solutions.face_mesh.FaceMesh(min_detection_confidence=.5, min_tracking_confidence=.5)
        self.hands = mp.solutions.hands.Hands(min_detection_confidence=.6, min_tracking_confidence=.5, max_num_hands=2)

    def analyze(self, frame):
        rgb = self.cv2.cvtColor(frame, self.cv2.COLOR_BGR2RGB)
        face_result = self.face.process(rgb)
        mesh_result = self.mesh.process(rgb)
        hand_result = self.hands.process(rgb)
        landmarks = mesh_result.multi_face_landmarks[0].landmark if mesh_result.multi_face_landmarks else None
        height, width = frame.shape[:2]
        phones = []
        for result in self.yolo(frame, verbose=False, conf=.4):
            for box in result.boxes:
                if self.yolo.names[int(box.cls[0])] == 'cell phone':
                    x1, y1, x2, y2 = box.xyxy[0].cpu().tolist()
                    phones.append({'x': x1 / width, 'y': y1 / height,
                                   'width': (x2 - x1) / width, 'height': (y2 - y1) / height,
                                   'score': float(box.conf[0])})
        hands = [[{'x': p.x, 'y': p.y} for p in h.landmark] for h in hand_result.multi_hand_landmarks or []]
        near = any(b['x'] - .06 <= p['x'] <= b['x'] + b['width'] + .06 and
                   b['y'] - .06 <= p['y'] <= b['y'] + b['height'] + .06
                   for b in phones for hand in hands for p in hand)
        faces = []
        for detection in face_result.detections or []:
            b = detection.location_data.relative_bounding_box
            faces.append({'x': b.xmin, 'y': b.ymin, 'width': b.width, 'height': b.height})
        sample = {'facePresent': bool(face_result.detections), 'direction': head_pose(landmarks),
                  'mouthOpen': mouth_open(landmarks), 'phoneVisible': bool(phones),
                  'phoneNearHand': near, 'phones': phones, 'hands': hands, 'faces': faces,
                  'calibrated': True}
        return sample

    def close(self):
        self.face.close(); self.mesh.close(); self.hands.close()


def preview_jpeg(frame, sample=None):
    """Draw the most recent detections on a fresh frame, independently of inference."""
    import cv2
    height, width = frame.shape[:2]
    sample = sample or {}
    for b in sample.get('phones', []):
        x, y = int(b['x'] * width), int(b['y'] * height)
        cv2.rectangle(frame, (x, y), (int((b['x'] + b['width']) * width), int((b['y'] + b['height']) * height)), (40, 80, 235), 2)
        cv2.putText(frame, f"PHONE {b['score']:.2f}", (x, max(18, y - 6)), cv2.FONT_HERSHEY_SIMPLEX, .5, (40, 80, 235), 1)
    for b in sample.get('faces', []):
        cv2.rectangle(frame, (int(b['x'] * width), int(b['y'] * height)),
                           (int((b['x'] + b['width']) * width), int((b['y'] + b['height']) * height)), (180, 210, 130), 2)
    for hand in sample.get('hands', []):
        for p in hand:
            cv2.circle(frame, (int(p['x'] * width), int(p['y'] * height)), 2, (180, 210, 130), -1)
    ok, encoded = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return encoded.tobytes() if ok else None


class Sounds:
    def __init__(self):
        self.loaded = False
        self.error = None

    def play(self, returned=False):
        try:
            if not self.loaded:
                os.environ['PYGAME_HIDE_SUPPORT_PROMPT'] = '1'
                import pygame
                self.pygame = pygame
                pygame.mixer.init()
                self.warning = pygame.mixer.Sound(str(ROOT / 'go_back.mp3'))
                self.returned = pygame.mixer.Sound(str(ROOT / 'alert.mp3'))
                self.loaded = True
            self.pygame.mixer.stop()
            (self.returned if returned else self.warning).play()
        except Exception:
            self.error = 'The audio device is unavailable. Visual distraction alerts are still active.'

    def stop(self):
        if self.loaded:
            self.pygame.mixer.stop()


def active_window():
    # Same source as study_monitor.py: the foreground window title contains the
    # current browser tab title as well as native application titles on Windows.
    import pygetwindow as gw
    window = gw.getActiveWindow()
    return window.title if window else ''
