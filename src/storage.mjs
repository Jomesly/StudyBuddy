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
  const empty = { history: [], current: null, preferences: { theme: 'system', mute: true, cameraName: '' }, storageAvailable: true, hasSavedData: false };
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
      },
    };
  } catch { return { ...empty, storageAvailable: false }; }
}

export function save({ history, current, preferences }, storage) {
  try {
    storage ||= globalThis.localStorage;
    storage.setItem(KEY, JSON.stringify({ history: history.slice(0, 500), current, preferences }));
    return true;
  } catch { return false; }
}
