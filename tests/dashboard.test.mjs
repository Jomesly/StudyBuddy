import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, duration, pickCamera } from '../src/dashboard.mjs';

test('tiles count only real sessions from today and the last seven days', () => {
  const now = new Date(2026, 9, 31, 15, 0);
  const at = (days, hour) => new Date(2026, 9, 31 - days, hour).toISOString();
  const history = [
    { startedAt: at(0, 9), active: 1500, reminders: 2 },
    { startedAt: at(0, 13), active: 600, reminders: 0 },
    { startedAt: at(6, 8), active: 3000, reminders: 1 },
    { startedAt: at(7, 8), active: 9999, reminders: 9 },
  ];
  assert.deepEqual(summarize(history, now), { today: 2100, week: 5100, sessions: 3, reminders: 3 });
  assert.deepEqual(summarize([], now), { today: 0, week: 0, sessions: 0, reminders: 0 });
});

test('durations read naturally at a glance', () => {
  assert.equal(duration(0), '0 min');
  assert.equal(duration(2100), '35 min');
  assert.equal(duration(3600), '1 h');
  assert.equal(duration(5100), '1 h 25 min');
});

test('the saved camera is found by name even when its number changes', () => {
  const cameras = [{ index: 0, name: 'OBS Virtual Camera', virtual: true }, { index: 1, name: 'ASUS FHD webcam', virtual: false }];
  assert.deepEqual(pickCamera(cameras, 'ASUS FHD webcam', 0), { camera: cameras[1], fallback: false });
  assert.deepEqual(pickCamera(cameras, '', 0), { camera: cameras[0], fallback: false });
  assert.deepEqual(pickCamera(cameras, 'Unplugged cam', 0), { camera: cameras[1], fallback: true });
  assert.deepEqual(pickCamera([], 'ASUS FHD webcam', 0), { camera: null, fallback: true });
});
