export const RUNNING_STATES = ['focus', 'paused', 'break'];

export class Session {
  constructor({ task, mode = 'screen', duration = 1500, tabCheck = false, mouthCheck = false }, now = Date.now()) {
    this.id = globalThis.crypto.randomUUID();
    this.task = task;
    this.mode = mode;
    this.duration = duration;
    this.remaining = duration;
    this.active = 0;
    this.paused = 0;
    this.reminders = 0;
    this.tabCheck = tabCheck;
    this.mouthCheck = mouthCheck;
    this.breakRemaining = 300;
    this.state = 'focus';
    this.startedAt = new Date(now).toISOString();
    this.anchor = now;
    this.note = '';
    this.observations = {};
  }

  tick(now = Date.now()) {
    const elapsed = Math.max(0, (now - this.anchor) / 1000);
    this.anchor = now;
    if (this.state === 'focus') {
      const used = Math.min(elapsed, this.remaining);
      this.active += used;
      this.remaining = Math.max(0, this.remaining - used);
      if (this.remaining === 0) this.state = 'break';
    } else if (this.state === 'paused') {
      this.paused += elapsed;
    } else if (this.state === 'break') {
      this.breakRemaining = Math.max(0, this.breakRemaining - elapsed);
      if (this.breakRemaining === 0) this.state = 'summary';
    }
    return this.state;
  }

  togglePause(now = Date.now()) {
    this.tick(now);
    if (this.state === 'focus') this.state = 'paused';
    else if (this.state === 'paused') this.state = 'focus';
    return this.state;
  }

  end(now = Date.now()) {
    this.tick(now);
    this.state = 'summary';
  }

  record() {
    const { anchor, ...record } = this;
    return { ...record, observations: { ...this.observations } };
  }

  static restore(snapshot, now = Date.now()) {
    const session = Object.assign(Object.create(Session.prototype), snapshot);
    // Never infer study time while the page was closed, or restart the camera.
    if (session.state === 'focus' || session.state === 'paused') session.state = 'paused';
    session.anchor = now;
    return session;
  }
}

export function format(seconds) {
  const n = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

export function minutes(seconds) {
  return seconds < 60 ? `${Math.floor(seconds)} sec` : `${Math.floor(seconds / 60)} min`;
}
