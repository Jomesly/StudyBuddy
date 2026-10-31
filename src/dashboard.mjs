const DAY = 86400000;

/** Totals for the dashboard tiles, computed only from saved sessions. */
export function summarize(history, now = new Date()) {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekStart = startOfToday - 6 * DAY;
  const totals = { today: 0, week: 0, sessions: 0, reminders: 0 };
  for (const record of history) {
    const started = Date.parse(record.startedAt);
    if (!Number.isFinite(started) || started < weekStart) continue;
    if (started >= startOfToday) totals.today += record.active;
    totals.week += record.active; totals.sessions++; totals.reminders += record.reminders;
  }
  return totals;
}

export function duration(seconds) {
  const total = Math.floor(Math.max(0, seconds) / 60);
  if (total < 60) return `${total} min`;
  return total % 60 ? `${Math.floor(total / 60)} h ${total % 60} min` : `${Math.floor(total / 60)} h`;
}

/** Device numbers shift when cameras are plugged in, so the saved choice is matched by name first. */
export function pickCamera(cameras, savedName, currentIndex) {
  if (!cameras.length) return { camera: null, fallback: Boolean(savedName) };
  const byName = cameras.find(c => c.name === savedName);
  if (byName) return { camera: byName, fallback: false };
  const current = !savedName && cameras.find(c => c.index === currentIndex);
  if (current) return { camera: current, fallback: false };
  return { camera: cameras.find(c => !c.virtual) || cameras[0], fallback: Boolean(savedName) };
}
