import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../src/session.mjs';

test('an ongoing pause is excluded when ending without resuming', () => {
  const session = new Session({ task: 'Read', duration: 1500 }, 0);
  session.togglePause(120000);
  session.end(300000);
  assert.equal(session.active, 120);
  assert.equal(session.paused, 180);
  assert.equal(session.remaining, 1380);
});

test('resume uses wall-clock deltas, independent of timer callback frequency', () => {
  const session = new Session({ task: 'Read', duration: 1500 }, 0);
  session.togglePause(60000);
  session.togglePause(240000);
  session.end(330000);
  assert.equal(session.active, 150);
  assert.equal(session.paused, 180);
});

test('a throttled tab caps active time at the planned duration and offers a full break', () => {
  const session = new Session({ task: 'Read', duration: 900 }, 0);
  assert.equal(session.tick(3600000), 'break');
  assert.equal(session.active, 900);
  assert.equal(session.breakRemaining, 300);
  assert.equal(session.tick(3900000), 'summary');
});

test('restore pauses a session, adds no time while closed, and preserves observations', () => {
  const session = new Session({ task: 'Read', duration: 900 }, 0);
  session.tick(30000); session.observations.away = 4;
  const restored = Session.restore(session.record(), 86400000);
  assert.equal(restored.state, 'paused');
  assert.equal(restored.active, 30);
  restored.togglePause(86410000);
  restored.tick(86420000);
  assert.equal(restored.active, 40);
  assert.equal(restored.paused, 10);
  assert.equal(restored.observations.away, 4);
});

test('a backwards clock never creates negative study time', () => {
  const session = new Session({ task: 'Read', duration: 900 }, 10000);
  session.tick(9000);
  assert.equal(session.active, 0);
  assert.equal(session.remaining, 900);
});
