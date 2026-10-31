// These are camera observations, never a measure of attention or productivity.
export function classifyObservation(sample, { mode = 'screen', mouthCheck = false } = {}) {
  if (sample.appDistracted) return 'distraction-app';
  if (!sample.facePresent) return 'away';
  if (sample.phoneVisible) return sample.phoneNearHand ? 'phone-hand' : 'phone';
  if (mouthCheck && mode !== 'lecture' && sample.mouthOpen) return 'mouth';
  if (sample.direction === 'left' || sample.direction === 'right' ||
      (sample.direction === 'down' && mode === 'screen')) return 'looking-away';
  return 'present';
}

export const observationLabels = {
  'distraction-app': 'Distracting app or tab', talking: 'Possible talking',
  away: 'Face not in view', phone: 'Phone in view', 'phone-hand': 'Phone near a hand',
  mouth: 'Mouth movement', 'looking-away': 'Head turned away', present: 'Face in view',
};

export const reminderMessages = {
  'distraction-app': 'A distracting app or tab is active. Ready to return to your task?',
  away: 'We cannot see your face. Still working? You can pause if you need a moment.',
  phone: 'A phone is in view. Is it part of your task?',
  'phone-hand': 'A phone appears close to your hand. A small moment to return to your task?',
  mouth: 'We noticed sustained mouth movement. If you are reading aloud, you can turn this reminder off.',
  'looking-away': 'Taking a look around is normal. Ready to return to your task?',
  tab: 'Welcome back. Were you working in another tab? You are in charge of your session.',
};

export class ObservationTracker {
  constructor() { this.reset(); }
  reset() { this.kind = null; this.since = 0; this.last = null; }
  observe(kind, now) {
    const gap = this.last === null ? 0 : (now - this.last) / 1000;
    // Do not fill in unobserved time when inference stalls or a tab is hidden.
    const continuous = gap >= 0 && gap <= 2;
    if (kind !== this.kind || !continuous) { this.kind = kind; this.since = now; }
    this.last = now;
    const stable = now - this.since >= (kind === 'away' ? 6000 : 3500);
    return { stable, seconds: continuous ? Math.max(0, gap) : 0 };
  }
}

export function geometry(landmarks) {
  const left = landmarks[33], right = landmarks[263], nose = landmarks[1];
  const width = Math.max(0.01, Math.abs(right.x - left.x));
  const horizontal = (nose.x - (left.x + right.x) / 2) / width;
  const vertical = (nose.y - (left.y + right.y) / 2) / width;
  const mouthWidth = Math.max(0.001, Math.abs(landmarks[291].x - landmarks[61].x));
  return { horizontal, vertical, mouthOpen: Math.abs(landmarks[14].y - landmarks[13].y) / mouthWidth > 0.28 };
}

export function headDirection(pose, baseline) {
  if (!baseline) return 'calibrating';
  if (pose.horizontal - baseline.horizontal > 0.22) return 'right';
  if (pose.horizontal - baseline.horizontal < -0.22) return 'left';
  if (pose.vertical - baseline.vertical > 0.22) return 'down';
  return 'forward';
}
