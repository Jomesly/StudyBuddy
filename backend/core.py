"""Rules ported from study_monitor.py, with timing independent of the web tab."""
from collections import deque, Counter
import re

STUDY_KEYWORDS = [
    'visual studio code', 'vscode', 'pycharm', 'jupyter', 'word', 'excel',
    'powerpoint', 'google docs', 'notion', 'adobe', 'pdf', 'reader', 'notepad',
    'sublime', 'atom', 'eclipse', 'intellij', 'study', 'learn', 'canvas', 'moodle',
    'classroom', 'zoom', 'teams', 'github', 'stackoverflow', 'python', 'programming',
    'smartstudybuddy', 'studybuddy', 'focus',
]
DISTRACTION_KEYWORDS = [
    'youtube', 'facebook', 'instagram', 'twitter', 'tiktok', 'netflix', 'spotify',
    'steam', 'epic games', 'discord', 'valorant', 'league', 'minecraft', 'roblox',
    'game', 'twitch', 'reddit', 'pinterest', 'snapchat', 'whatsapp', 'messenger',
    'fortnite', 'apex', 'gta', 'cod', 'pubg', 'dota', 'csgo', 'overwatch',
    'among us', 'fall guys',
]


def matches(title, keyword):
    # Avoid the original "cod" matching "Visual Studio Code".
    return bool(re.search(r'(?<!\w)' + re.escape(keyword.lower()) + r'(?!\w)', title.lower()))


def classify_app(title, allowed=()):
    if not title or title == 'Unknown':
        return {'title': '', 'name': 'Unknown', 'isStudy': None}
    for word in allowed:
        if word.strip() and matches(title, word.strip()):
            return {'title': title[:240], 'name': word.strip(), 'isStudy': True}
    for word in DISTRACTION_KEYWORDS:
        if matches(title, word):
            return {'title': title[:240], 'name': word.title(), 'isStudy': False}
    for word in STUDY_KEYWORDS:
        if matches(title, word):
            return {'title': title[:240], 'name': word.title(), 'isStudy': True}
    return {'title': title[:240], 'name': 'Other app', 'isStudy': None}


def head_pose(points):
    if not points:
        return 'unknown'
    nose, left, right = points[1], points[33], points[263]
    offset = (nose.x - (left.x + right.x) / 2) / (abs(right.x - left.x) + .001)
    if offset > .15:
        return 'right'
    if offset < -.15:
        return 'left'
    if nose.y - (points[133].y + points[362].y) / 2 > .25:
        return 'down'
    return 'forward'


def mouth_open(points):
    if not points:
        return False
    width = abs(points[291].x - points[61].x)
    return width > 0 and abs(points[14].y - points[13].y) / width > .25


MESSAGES = {
    'away': 'You appear to be away from your desk. Ready to return to your task?',
    'phone': 'Phone detected. Put it aside if it is not part of your task.',
    'talking': 'Possible talking detected from mouth movement and head direction.',
    'looking-away': 'You are looking away from your study area.',
    'distraction-app': 'A distracting app or tab is active.',
    'present': 'No distraction detected.',
    'checking': 'Checking your study activity…',
}


class DistractionRules:
    def __init__(self):
        self.phone = deque(maxlen=10)
        self.mouth = deque(maxlen=30)
        self.direction = deque(maxlen=15)
        self.last_sequence = None
        self.last_sample = None
        self.absent_since = None
        self.stable_direction = 'unknown'
        self.direction_since = 0

    def evaluate(self, sample, app, now, *, camera_enabled=True, app_enabled=True,
                 mode='screen', mouth_check=True):
        fresh = camera_enabled and sample and now - sample['at'] < 3
        if fresh and sample['sequence'] != self.last_sequence:
            if self.last_sample is not None and now - self.last_sample > 3:
                self.phone.clear(); self.mouth.clear(); self.direction.clear()
                self.absent_since = None
            self.last_sample = now
            self.last_sequence = sample['sequence']
            self.phone.append(bool(sample['phoneVisible']))
            self.mouth.append(bool(sample['mouthOpen']))
            self.direction.append(sample['direction'])
            if sample['facePresent']:
                self.absent_since = None
            elif self.absent_since is None:
                self.absent_since = now
            direction = Counter(self.direction).most_common(1)[0][0]
            if direction != self.stable_direction:
                self.stable_direction, self.direction_since = direction, now
        if fresh:
            # Retain the original four-frame phone confirmation and .4 confidence.
            if sum(self.phone) >= 4:
                return 'phone'
            if self.absent_since is not None and now - self.absent_since >= 2:
                return 'away'
            turned = self.stable_direction in ('left', 'right', 'down')
            if mode in ('paper', 'lecture') and self.stable_direction == 'down':
                turned = False
            if (sample['facePresent'] and mouth_check and mode != 'lecture' and
                    sum(self.mouth) >= 15 and turned):
                return 'talking'
            if sample['facePresent'] and turned and now - self.direction_since >= 1.5:
                return 'looking-away'
        # App checks work even when the camera is disabled, busy, or loading.
        if app_enabled and app.get('isStudy') is False:
            return 'distraction-app'
        if fresh and sample['facePresent'] and self.stable_direction == 'forward':
            return 'present'
        if not camera_enabled and app_enabled and app.get('isStudy') is True:
            return 'present'
        return 'checking'
