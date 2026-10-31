import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyObservation, ObservationTracker, headDirection } from '../src/observations.mjs';

const present = { facePresent: true, direction: 'forward', mouthOpen: false, phoneVisible: false, phoneNearHand: false };
test('missing face data is never treated as facing forward', () => {
  assert.equal(classifyObservation({ ...present, facePresent: false }), 'away');
});
test('paper notes allow looking down; lectures allow mouth movement', () => {
  assert.equal(classifyObservation({ ...present, direction: 'down' }, { mode: 'paper' }), 'present');
  assert.equal(classifyObservation({ ...present, direction: 'down' }, { mode: 'screen' }), 'looking-away');
  assert.equal(classifyObservation({ ...present, mouthOpen: true }, { mode: 'lecture', mouthCheck: true }), 'present');
  assert.equal(classifyObservation({ ...present, mouthOpen: true }, { mode: 'screen', mouthCheck: true }), 'mouth');
});
test('phone visibility and hand proximity remain distinct observations', () => {
  assert.equal(classifyObservation({ ...present, phoneVisible: true }), 'phone');
  assert.equal(classifyObservation({ ...present, phoneVisible: true, phoneNearHand: true }), 'phone-hand');
});
test('brief detections do not trigger reminders, and stalled inference time is not counted', () => {
  const tracker = new ObservationTracker();
  assert.deepEqual(tracker.observe('phone', 0), { stable: false, seconds: 0 });
  assert.equal(tracker.observe('phone', 1000).stable, false);
  assert.equal(tracker.observe('phone', 2000).seconds, 1);
  assert.equal(tracker.observe('phone', 3500).stable, true);
  assert.deepEqual(tracker.observe('phone', 30000), { stable: false, seconds: 0 });
});
test('camera gaps reset reminder stability, and head direction is relative to calibration', () => {
  const tracker = new ObservationTracker();
  tracker.observe('away', 0); tracker.observe('away', 1000);
  tracker.reset();
  assert.equal(tracker.observe('away', 5000).stable, false);
  const baseline = { horizontal: 0.1, vertical: 0.4 };
  assert.equal(headDirection(baseline, null), 'calibrating');
  assert.equal(headDirection(baseline, baseline), 'forward');
  assert.equal(headDirection({ horizontal: 0.5, vertical: 0.4 }, baseline), 'right');
  assert.equal(headDirection({ horizontal: 0.1, vertical: 0.7 }, baseline), 'down');
});
