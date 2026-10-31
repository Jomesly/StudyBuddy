import test from 'node:test';
import assert from 'node:assert/strict';
import { load, save } from '../src/storage.mjs';
import { Session } from '../src/session.mjs';

function memoryStorage() {
  let value = null;
  return { getItem: () => value, setItem: (_key, next) => { value = next; } };
}
test('history, notes, and preferences survive reload; invalid observations are removed', () => {
  const storage = memoryStorage(), record = new Session({ task: 'Chapter 4' }).record();
  record.note = 'Understood the examples'; record.observations = { phone: 5, invalid: 10, away: -4 };
  assert.equal(save({ history: [record], current: record, preferences: { theme: 'dark', mute: false, cameraName: 'ASUS FHD webcam' } }, storage), true);
  const loaded = load(storage);
  assert.equal(loaded.history[0].note, record.note);
  assert.deepEqual(loaded.history[0].observations, { phone: 5 });
  assert.equal(loaded.current.task, record.task);
  assert.deepEqual(loaded.preferences, { theme: 'dark', mute: false, cameraName: 'ASUS FHD webcam' });
});
test('corrupted or blocked storage does not prevent a timer-only session', () => {
  const corrupt = { getItem: () => '{broken' };
  assert.equal(load(corrupt).history.length, 0);
  const blocked = { getItem() { throw Error('blocked'); }, setItem() { throw Error('quota'); } };
  assert.equal(load(blocked).storageAvailable, false);
  assert.equal(save({ history: [], current: null, preferences: {} }, blocked), false);
});
test('malformed snapshots are discarded rather than breaking startup', () => {
  const storage = memoryStorage();
  storage.setItem('', JSON.stringify({ history: [{ task: 'Missing fields' }], current: { state: 'focus' } }));
  assert.deepEqual(load(storage).history, []);
  assert.equal(load(storage).current, null);
});

test('the new brand preserves existing history, notes and preferences', () => {
  const record = { ...new Session({ task: 'Saved chapter notes' }).record(), note: 'Keep this reflection' };
  const values = new Map([['focusbuddy.web.v1', JSON.stringify({ history: [record], current: record, preferences: { theme: 'dark', mute: false, cameraName: 'USB Webcam' } })]]);
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const loaded = load(storage);
  assert.equal(loaded.history[0].note, record.note);
  assert.equal(loaded.current.task, record.task);
  assert.equal(loaded.hasSavedData, true);
  assert.equal(loaded.preferences.mute, false);
  assert.equal(save(loaded, storage), true);
  assert.ok(values.has('studybuddy.web.v1'));
  save({ ...loaded, history: [], current: null }, storage);
  assert.deepEqual(load(storage).history, []);
});
