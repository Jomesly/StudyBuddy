const KEY = 'studybuddy.web.v1';
const LEGACY_KEY = 'focusbuddy.web.v1';
const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const validRecord = r => r && typeof r.id === 'string' && typeof r.task === 'string' &&
  ['screen', 'paper', 'lecture'].includes(r.mode) && finite(r.active) && finite(r.paused) &&
  finite(r.duration) && r.duration > 0 && finite(r.remaining) && finite(r.reminders) &&
  typeof r.startedAt === 'string' && !Number.isNaN(Date.parse(r.startedAt)) &&
  finite(r.breakRemaining) && ['focus', 'paused', 'break', 'summary'].includes(r.state);

function normalize(record) {
  const observations = {};
  for (const key of ['away', 'phone', 'phone-hand', 'mouth', 'talking', 'distraction-app', 'looking-away', 'present', 'tab']) {
    if (finite(record.observations?.[key])) observations[key] = record.observations[key];
  }
  return { ...record, task: record.task.slice(0, 100), note: typeof record.note === 'string' ? record.note.slice(0, 5000) : '',
    tabCheck: record.tabCheck === true, mouthCheck: record.mouthCheck === true, observations };
}

export function load(storage) {
  const empty = { history: [], current: null, preferences: { theme: 'system', mute: true, cameraName: '', reminderCooldown: 60 }, storageAvailable: true, hasSavedData: false };
  try {
    storage ||= globalThis.localStorage;
    const raw = storage.getItem(KEY) || storage.getItem(LEGACY_KEY);
    if (!raw) return empty;
    const saved = JSON.parse(raw);
    return {
      ...empty,
      hasSavedData: true,
      history: Array.isArray(saved.history) ? saved.history.filter(validRecord).slice(0, 500).map(normalize) : [],
      current: validRecord(saved.current) && ['focus', 'paused', 'break'].includes(saved.current.state) ? normalize(saved.current) : null,
      preferences: {
        theme: ['light', 'dark', 'system'].includes(saved.preferences?.theme) ? saved.preferences.theme : 'system',
        mute: saved.preferences?.mute !== false,
        cameraName: typeof saved.preferences?.cameraName === 'string' ? saved.preferences.cameraName.slice(0, 120) : '',
        reminderCooldown: [5, 30, 60, 120].includes(saved.preferences?.reminderCooldown) ? saved.preferences.reminderCooldown : 60,
      },
    };
  } catch { return { ...empty, storageAvailable: false }; }
}

export function importHistory(text, existing) {
  if (text.length > 10 * 1024 * 1024) throw new Error('Choose a backup smaller than 10 MB.');
  let backup;
  try { backup = JSON.parse(text); } catch { throw new Error('This file is not valid JSON. Choose a StudyBuddy history export.'); }
  if (!Array.isArray(backup?.sessions) || !backup.sessions.length || backup.sessions.length > 500) {
    throw new Error('Choose a StudyBuddy export containing between 1 and 500 sessions.');
  }
  const incoming = backup.sessions.map(record => {
    if (!validRecord(record) || record.state !== 'summary' || !record.id.trim() || record.id.length > 100 ||
        !record.task.trim() || record.task.length > 100 || record.duration > 10800 ||
        record.active > record.duration + 1 || record.remaining > record.duration ||
        record.paused > 31536000 || !Number.isInteger(record.reminders) || record.reminders > 100000 ||
        (record.note !== undefined && (typeof record.note !== 'string' || record.note.length > 5000))) {
      throw new Error('The backup contains an invalid session. No history was changed.');
    }
    const { id, task, mode, duration, remaining, active, paused, reminders, startedAt, breakRemaining } = record;
    return normalize({ id, task, mode, duration, remaining, active, paused, reminders, startedAt, breakRemaining,
      state: 'summary', engine: record.engine === 'python' ? 'python' : 'browser',
      endedAt: typeof record.endedAt === 'string' && Number.isFinite(Date.parse(record.endedAt)) ? record.endedAt : startedAt,
      note: record.note, tabCheck: record.tabCheck, mouthCheck: record.mouthCheck, observations: record.observations });
  });
  const merged = new Map(existing.map(record => [record.id, record]));
  let added = 0;
  for (const record of incoming) if (!merged.has(record.id)) { merged.set(record.id, record); added++; }
  return { history: [...merged.values()].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).slice(0, 500), added };
}

export function save({ history, current, preferences }, storage) {
  try {
    storage ||= globalThis.localStorage;
    storage.setItem(KEY, JSON.stringify({ history: history.slice(0, 500), current, preferences }));
    return true;
  } catch { return false; }
}
