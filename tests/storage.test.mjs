import test from 'node:test';
import assert from 'node:assert/strict';
import { load, save, importHistory } from '../src/storage.mjs';
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
  assert.deepEqual(loaded.preferences, { theme: 'dark', mute: false, cameraName: 'ASUS FHD webcam', reminderCooldown: 60 });
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

function completed(task = 'Imported notes') {
  const session = new Session({ task }); session.end();
  return { ...session.record(), note: 'Keep this note', endedAt: new Date().toISOString() };
}

test('history import roundtrips exports and keeps existing notes on duplicate IDs', () => {
  const record = completed();
  const backup = JSON.stringify({ sessions: [record, record] });
  const imported = importHistory(backup, []);
  assert.equal(imported.added, 1);
  assert.equal(imported.history[0].note, record.note);
  const existing = { ...record, note: 'My newer reflection' };
  const merged = importHistory(backup, [existing]);
  assert.equal(merged.added, 0);
  assert.deepEqual(merged.history, [existing]);
});

test('history import validates the entire backup before merging and strips unexpected fields', () => {
  const record = completed();
  for (const text of ['{bad', '{}', '{"sessions":[]}', JSON.stringify({ sessions: [record, { ...record, active: -1 }] }),
    JSON.stringify({ sessions: [{ ...record, state: 'focus' }] }), JSON.stringify({ sessions: [{ ...record, note: 123 }] }),
    JSON.stringify({ sessions: Array(501).fill(record) }), ' '.repeat(10 * 1024 * 1024 + 1)]) {
    assert.throws(() => importHistory(text, []));
  }
  const safe = importHistory(JSON.stringify({ sessions: [{ ...record, key: 'discard', observations: { phone: 3, invalid: 10, away: -2 } }] }), []).history[0];
  assert.equal(safe.key, undefined);
  assert.deepEqual(safe.observations, { phone: 3 });
});

test('reminder preferences persist and unknown intervals fall back to one minute', () => {
  const storage = memoryStorage();
  save({ history: [], current: null, preferences: { reminderCooldown: 120 } }, storage);
  assert.equal(load(storage).preferences.reminderCooldown, 120);
  save({ history: [], current: null, preferences: { reminderCooldown: -5 } }, storage);
  assert.equal(load(storage).preferences.reminderCooldown, 60);
});
