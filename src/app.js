import { Session, RUNNING_STATES, format, minutes } from './session.mjs';
import { ObservationTracker, classifyObservation, observationLabels, reminderMessages } from './observations.mjs';
import { load, save, importHistory } from './storage.mjs';
import { CameraMonitor } from './monitor.js';
import { NativeMonitor } from './native-monitor.js';
import { summarize, duration, pickCamera } from './dashboard.mjs';
import '@fontsource-variable/inter/wght.css';

const $ = id => document.getElementById(id);
function setText(id, value) { if ($(id).textContent !== value) $(id).textContent = value; }
const saved = load();
let history = saved.history;
const preferences = saved.preferences;
let session = saved.current ? Session.restore(saved.current) : null;
let view = session ? 'session' : 'ready';
let summaryRecord = null;
let lastSavedAt = 0;
let snoozedUntil = 0;
let lastReminderAt = -Infinity;
let hiddenAt = null;
let hiddenUntil = null;
let tabAwaySeconds = 0;
let audioContext;
let nativeState = null;
let lastNativeEvent = 0;
let controlPending = false;
const tracker = new ObservationTracker();
const modeNames = { screen: 'Screen study', paper: 'Paper notes', lecture: 'Lecture' };
const modes = {
  screen: 'Choose the tools you need. Camera and tab reminders are optional.',
  paper: 'Looking down is part of the work. Head-down reminders are off for paper notes.',
  lecture: 'Make room for listening and discussion. Mouth movement reminders are off for lectures.',
};

$('camera').checked = !session;
$('app-check').checked = !session;
const originalMode = () => $('engine').value === 'python';
let cameraList = [];
let camerasLoaded = false;
let engineChecked = false;
let initialPreviewPending = !session;

let announceTimer;
function announce(message) {
  $('announcer').textContent = message;
  clearTimeout(announceTimer); // Shown as a toast, so it must not linger.
  announceTimer = setTimeout(() => { $('announcer').textContent = ''; }, 6000);
}
function button(text, action) {
  const el = document.createElement('button');
  el.type = 'button'; el.textContent = text; el.addEventListener('click', action);
  return el;
}
function notice(message, actions = []) {
  const changed = $('notice-text').textContent !== (message || '');
  $('notice').hidden = !message;
  setText('notice-text', message || '');
  $('notice-actions').replaceChildren(...actions.map(([label, action]) => button(label, action)));
  if (changed) setText('notice-announcer', message || '');
}
function showStorage(ok) {
  $('storage-status').textContent = ok ? 'Saved in this browser' : 'Storage unavailable · keep this page open';
  $('storage-status').hidden = ok;
}
function persist() {
  const ok = save({ history, current: session && RUNNING_STATES.includes(session.state) ? session.record() : null, preferences });
  showStorage(ok);
  return ok;
}
function saveRecord() {
  const existing = history.find(r => r.id === session.id);
  const record = { ...session.record(), state: 'summary', endedAt: new Date().toISOString(), note: existing?.note || '' };
  if (existing) Object.assign(existing, record);
  else { history.unshift(record); history = history.slice(0, 500); }
  summaryRecord = history.find(r => r.id === session.id);
  persist();
}
function setSupport(title, description, one, valueOne, two, valueTwo, noteText) {
  $('support-title').textContent = title; $('support-description').textContent = description;
  $('support-label-one').textContent = one; $('support-value-one').textContent = valueOne;
  $('support-label-two').textContent = two; $('support-value-two').textContent = valueTwo;
  $('support-note').textContent = noteText;
}
function focusHeading() { $('page-heading').focus({ preventScroll: true }); }
function renderTimer() {
  if (!session || view !== 'session') return;
  const onBreak = session.state === 'break';
  const remaining = onBreak ? session.breakRemaining : session.remaining;
  $('timer').textContent = format(remaining);
  $('session-progress').max = onBreak ? 300 : session.duration;
  $('session-progress').value = onBreak ? 300 - remaining : session.active;
  $('elapsed-label').textContent = `${minutes(onBreak ? 300 - remaining : session.active)} elapsed`;
  $('planned-label').textContent = `${onBreak ? 5 : session.duration / 60} min planned`;
  document.title = `${format(remaining)} · ${session.state === 'paused' ? 'Paused' : onBreak ? 'Break' : session.task} — StudyBuddy`;
}
function sessionRow(record, className) {
  const row = button('', () => { summaryRecord = record; view = 'summary'; render(); focusHeading(); });
  row.className = className;
  const text = document.createElement('div'), name = document.createElement('span');
  const sub = document.createElement('p'), time = document.createElement('strong'), reminders = document.createElement('span');
  name.textContent = record.task;
  sub.textContent = `${new Date(record.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} · ${modeNames[record.mode]}`;
  reminders.className = 'pill'; reminders.dataset.state = record.reminders ? 'warning' : 'calm';
  reminders.textContent = `${record.reminders} reminder${record.reminders === 1 ? '' : 's'}`;
  time.textContent = minutes(record.active);
  text.append(name, sub); row.append(text, reminders, time);
  return row;
}
function renderHistory() {
  const list = $('history-list'); list.replaceChildren();
  $('history-actions').hidden = false;
  $('export-history').hidden = $('clear-history').hidden = history.length === 0;
  $('clear-confirm').hidden = true;
  if (!history.length) {
    const message = document.createElement('p'); message.className = 'empty'; message.textContent = 'Your first session will appear here.';
    list.append(message, button('Plan a session', () => { view = 'ready'; render(); focusHeading(); }));
  }
  for (const record of history) list.append(sessionRow(record, 'history-row history-link'));
}
function renderDashboard() {
  const totals = summarize(history);
  $('stat-today').textContent = duration(totals.today);
  $('stat-week').textContent = duration(totals.week);
  $('stat-sessions').textContent = String(totals.sessions);
  $('stat-reminders').textContent = String(totals.reminders);
  $('stat-week-hint').textContent = totals.sessions ? `Across ${totals.sessions} session${totals.sessions === 1 ? '' : 's'}` : 'No sessions yet';
  $('stat-reminders-hint').textContent = totals.sessions ? totals.reminders ? `About ${Math.round(totals.reminders / totals.sessions * 10) / 10} per session` : 'None this week' : 'In the last 7 days';
  const recent = $('recent-list'); recent.replaceChildren();
  $('view-all-history').hidden = history.length === 0;
  if (!history.length) {
    const message = document.createElement('p'); message.className = 'empty';
    message.textContent = 'Your first session will appear here. Name a task above and press Start session.';
    recent.append(message);
  }
  for (const record of history.slice(0, 4)) recent.append(sessionRow(record, 'history-row recent-row'));
}
function renderObservations(record) {
  $('observation-list').replaceChildren();
  const totals = record.observations || {};
  const labels = { ...observationLabels, tab: 'Tab hidden' };
  for (const [key, label] of Object.entries(labels)) {
    if (!Number.isFinite(totals[key]) || totals[key] <= 0) continue;
    const row = document.createElement('div'), term = document.createElement('dt'), value = document.createElement('dd');
    term.textContent = label; value.textContent = minutes(totals[key]); row.append(term, value); $('observation-list').append(row);
  }
  if (!$('observation-list').children.length) {
    const message = document.createElement('p'); message.textContent = 'No observations recorded for this session.';
    $('observation-list').append(message);
  }
}
function render() {
  $('app').dataset.view = view;
  for (const name of ['ready', 'session', 'summary', 'history']) $(`${name}-view`).hidden = name !== view;
  $('nav-focus').setAttribute('aria-current', view === 'history' ? 'false' : 'page');
  $('nav-history').setAttribute('aria-current', view === 'history' ? 'page' : 'false');
  $('camera-panel').hidden = !['ready', 'session'].includes(view) || session?.state === 'break';
  $('stats').hidden = view !== 'history'; // Setup leads with the task; totals live in History.
  $('recent-card').hidden = view !== 'ready';
  $('monitoring-card').hidden = view !== 'ready';
  $('live-card').hidden = view !== 'session' || session?.state === 'break';
  $('support').hidden = ['ready', 'session'].includes(view);
  $('today-label').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  renderDashboard();
  $('saved-note').textContent = '';
  if (view !== 'session') document.title = 'StudyBuddy — a quieter study space';
  if (view === 'ready') {
    $('page-heading').innerHTML = 'Make room for <mark class="highlight">one thing</mark>.';
    $('page-description').textContent = 'Choose a task. Find a comfortable pace.';
    setSupport('Your pace, your space.', modes[$('mode').value], 'After this session', 'A 5-minute break', 'Reminders', preferences.mute ? 'Gentle and quiet' : 'Sound enabled', 'No scores to chase. Just the task you chose.');
  } else if (view === 'session') {
    const state = session.state;
    $('page-heading').textContent = state === 'break' ? 'Take a little breathing room.' : session.task;
    $('page-description').textContent = state === 'paused' ? 'Your session is paused. Take the time you need.' : state === 'break' ? 'Step away, stretch, or simply rest.' : 'One thing at a time. You set the pace.';
    $('session-label').textContent = state === 'break' ? 'Planned break' : state === 'paused' ? 'Session paused' : 'Focus session';
    $('timer-caption').textContent = state === 'paused' ? 'The timer is waiting for you.' : state === 'break' ? 'Your work can wait a few minutes.' : 'A little time for your next step.';
    $('pause').textContent = state === 'paused' ? 'Resume session' : state === 'break' ? 'Finish break' : 'Pause session';
    $('end').textContent = state === 'break' ? 'View session recap' : 'End session';
    setSupport(state === 'break' ? 'Rest belongs here.' : 'A quieter workspace.', state === 'break' ? 'Breaks are part of a sustainable rhythm. Camera capture is off during your break.' : originalMode() ? 'The original detection engine keeps monitoring when you switch to another tab or application.' : 'Browser-only camera checks run while this tab is visible.', 'Study style', modeNames[session.mode], 'Reminders', preferences.mute ? 'Silent' : 'Sound enabled', state === 'paused' ? 'Camera capture is off while paused.' : 'Need to adjust something? Your preferences are in Settings.');
    if (!originalMode()) {
      $('live-status').dataset.warning = 'false';
      if (monitor.state !== 'on') $('live-status').textContent = session.tabCheck ? 'Tab-away reminders on' : 'Camera and tab checks are off';
      $('active-app').textContent = 'Browser-only mode cannot see other apps. Choose the Python engine for app detection.';
    }
    renderTimer();
  } else if (view === 'summary' && summaryRecord) {
    $('page-heading').textContent = 'A moment to look back.';
    $('page-description').textContent = summaryRecord.task;
    $('summary-active').textContent = minutes(summaryRecord.active);
    $('summary-paused').textContent = minutes(summaryRecord.paused);
    $('summary-reminders').textContent = String(summaryRecord.reminders);
    $('reflection').value = summaryRecord.note || '';
    renderObservations(summaryRecord);
    setSupport('Small steps add up.', 'Take what helped from this session into the next one.', 'Next step', 'Your choice', 'Session notes', 'Saved on this device', 'Your progress does not need a perfect score.');
  } else if (view === 'history') {
    $('page-heading').textContent = 'Your recent sessions.';
    $('page-description').textContent = 'A quiet record of the time you made.';
    renderHistory();
    setSupport('A record, not a ranking.', 'Notice which tasks and session lengths felt right for you.', 'Saved sessions', String(history.length), 'Storage', 'This browser · this device', 'Keep a copy with Export history. The most recent 500 sessions are retained.');
  }
  updateSensorStatus();
}

function setChip(id, state, text) {
  $(id).dataset.state = state;
  $(id).title = text;
  setText(id === 'engine-chip' ? 'engine-chip-text' : id, text);
}
function updateMonitoringSummary() {
  const camera = $('camera').checked ? 'Camera reminders on' : 'Camera reminders off';
  const apps = $('app-check').checked ? (originalMode() ? 'App checks on' : 'Tab checks on') : 'App checks off';
  const talking = $('mode').value !== 'lecture' && $('mouth-check').checked ? 'Talking reminders on' : '';
  $('monitoring-summary').textContent = [camera, apps, talking].filter(Boolean).join(' · ');
}
function updateSensorStatus() {
  updateMonitoringSummary();
  const camera = originalMode() ? nativeState?.cameraState || 'off' : monitor.state;
  $('camera-panel').dataset.camera = camera;
  const status = !originalMode() ? 'Browser mode' : !native.ready ? 'Engine disconnected'
    : nativeState?.busy ? 'Session in another tab' : session?.state === 'paused' ? 'Monitoring paused'
    : session?.state === 'focus' ? 'Monitoring active' : 'Ready to study';
  const cameraStatus = camera === 'on' ? 'Camera on' : ['starting', 'loading'].includes(camera) ? 'Camera starting'
    : camera === 'error' ? 'Camera needs attention' : 'Camera off';
  const text = `${status} · ${cameraStatus}`;
  if ($('workspace-status').textContent !== text) $('workspace-status').textContent = text;
  const snoozeSeconds = originalMode() ? nativeState?.snoozeRemaining || 0 : Math.max(0, (snoozedUntil - Date.now()) / 1000);
  $('snooze-status').hidden = snoozeSeconds <= 0;
  $('snooze-status').textContent = snoozeSeconds > 0 ? `Reminders snoozed · ${format(snoozeSeconds)}` : '';
  setChip('camera-chip', camera === 'starting' ? 'loading' : camera, { off: 'Off', starting: 'Starting', loading: 'Starting', on: 'On', error: 'Needs attention' }[camera] || 'Off');
  if (!originalMode()) setChip('engine-chip', 'browser', 'Browser-only mode');
  else if (!engineChecked) setChip('engine-chip', 'connecting', 'Connecting to engine');
  else setChip('engine-chip', native.ready ? 'connected' : 'offline', native.ready ? 'Python engine connected' : 'Engine offline');
  if (originalMode()) {
    // "ready" = switched on and waiting for a session, so the sidebar never contradicts the switches.
    const running = nativeState?.phase === 'focus';
    const cameraText = camera !== 'off' ? camera : $('camera').checked && !running ? 'ready' : 'off';
    const appText = running && nativeState.options?.appCheck ? 'on' : !running && $('app-check').checked ? 'ready' : 'off';
    $('sensor-status').textContent = `Camera ${cameraText} · App checks ${appText}`;
    return;
  }
  const names = { off: 'Camera off', starting: 'Camera permission pending', loading: 'Camera on · loading detection', on: 'Camera reminders on', error: 'Camera unavailable' };
  const tabCheck = session && RUNNING_STATES.includes(session.state) ? session.tabCheck : $('app-check').checked;
  $('sensor-status').textContent = `${names[monitor.state]} · Tab reminders ${tabCheck ? 'on' : 'off'}`;
}

const monitor = new CameraMonitor($('camera-video'), {
  onState(state, message) {
    $('camera-message').textContent = message;
    $('enable-camera').hidden = state !== 'off' && state !== 'error';
    $('enable-camera').disabled = session?.state === 'paused';
    $('enable-camera').textContent = state === 'error' ? 'Retry camera' : 'Enable camera';
    $('stop-camera').hidden = !['starting', 'loading', 'on'].includes(state);
    $('camera-placeholder').hidden = ['loading', 'on'].includes(state);
    $('calibrate-camera').disabled = state !== 'on';
    if (state !== 'on') {
      tracker.reset();
      $('face-detail').textContent = 'Not checked'; $('phone-detail').textContent = 'Not checked'; $('hands-detail').textContent = 'Not checked';
      $('camera-overlay').getContext('2d').clearRect(0, 0, 640, 480);
    }
    if (state === 'on' || state === 'loading') {
      $('camera-video').parentElement.style.aspectRatio = `${$('camera-video').videoWidth} / ${$('camera-video').videoHeight}`;
    }
    updateSensorStatus();
    if (state === 'on') listCameras();
  },
  onSample(sample) {
    $('face-detail').textContent = !sample.facePresent ? 'Face not in view' : !sample.calibrated ? 'Look at the camera to calibrate…' : `Face in view · ${sample.direction}`;
    $('phone-detail').textContent = sample.phoneNearHand ? 'Phone near a hand' : sample.phoneVisible ? 'Phone in view' : 'No phone detected';
    $('hands-detail').textContent = `${sample.hands.length} in view`;
    drawOverlay(sample);
    if (session?.state !== 'focus' || document.hidden) { tracker.reset(); return; }
    const kind = classifyObservation(sample, session);
    setText('live-status', observationLabels[kind] || kind);
    const observed = tracker.observe(kind, Date.now());
    session.observations[kind] = (session.observations[kind] || 0) + observed.seconds;
    if (observed.stable && kind !== 'present') remind(kind);
  },
});

const native = new NativeMonitor({
  onConnection(ready, message) {
    engineChecked = true;
    $('engine-connection').textContent = originalMode() ? message : 'Limited mode: browser camera models and tab-away checks only.';
    if (ready && originalMode() && !session && $('camera').checked) initialPreviewPending = true;
    if (ready && !camerasLoaded) void loadNativeCameras();
    if (!ready) camerasLoaded = false;
    if (!ready) native.stopPreview($('native-camera-image'));
    if (originalMode()) updateSensorStatus();
    if (!ready && originalMode() && session?.state === 'focus') $('live-status').textContent = 'Engine disconnected · detection cannot be confirmed';
  },
  onState: applyNativeState,
});

function applyNativeState(state) {
  const wasBusy = nativeState?.busy;
  nativeState = state;
  if (!originalMode()) return;
  if (state.busy) {
    native.stopPreview($('native-camera-image'));
    const message = state.canRecover ? 'The previous tab disconnected. Recover its saved session with the camera off.'
      : 'Another StudyBuddy tab owns the session. Return to that tab, or recover here once it disconnects.';
    $('engine-connection').textContent = message;
    if ($('notice-text').textContent !== message) notice(message, state.canRecover ? [['Recover session', recoverNativeSession]] : []);
    updateSensorStatus();
    return;
  }
  if (wasBusy) notice('');
  if (state.released && session?.id === state.sessionId) $('camera').checked = false;
  if (session?.engine === 'python' && RUNNING_STATES.includes(session.state) && state.sessionId !== session.id) {
    lastNativeEvent = 0;
    if (session.state !== 'paused' || session.remaining <= 0) {
      session.state = session.remaining > 0 ? 'paused' : 'summary';
      $('camera').checked = false;
      if (session.state === 'summary') { saveRecord(); view = 'summary'; }
      persist(); render();
    }
    const message = 'Your saved progress is paused. Resume to continue after the engine restart, or end the session to keep its recap.';
    if ($('notice-text').textContent !== message) notice(message);
  }
  const camera = state.cameraState;
  const fps = state.cameraFps ? ` · ${Math.round(state.cameraFps)} FPS` : '';
  setText('camera-message', state.cameraError || state.detectionError || (camera === 'on' ? `Live camera. ${state.sample ? 'Distraction detection is running.' : 'Starting distraction detection…'}` : camera === 'loading' ? 'Starting the camera…' : camerasLoaded && !cameraList.length ? 'No camera found. Connect a camera, then refresh the list. The timer and app detection still work.' : 'Camera off. Enable it for phone, face, head and hand checks.'));
  $('camera-fps').textContent = camera === 'on' ? `${fps.replace(' · ', '')}${state.detectionFps ? ` · Detection ${state.detectionFps} FPS` : ''}` : '';
  $('enable-camera').hidden = ['loading', 'on'].includes(camera);
  $('enable-camera').disabled = session?.state === 'paused';
  $('stop-camera').hidden = !['loading', 'on'].includes(camera);
  $('camera-placeholder').hidden = camera === 'on';
  $('native-camera-image').hidden = camera !== 'on';
  $('camera-video').hidden = true; $('camera-overlay').hidden = true;
  $('calibrate-camera').hidden = true;
  syncNativePreview();
  if (state.sample && camera === 'on') {
    $('face-detail').textContent = state.sample.facePresent ? `Face in view · ${state.sample.direction}` : 'Face not in view';
    $('phone-detail').textContent = state.sample.phoneVisible ? `Phone detected${state.sample.phoneNearHand ? ' · near a hand' : ''}` : 'No phone detected';
    $('hands-detail').textContent = `${state.sample.hands.length} in view`;
  }
  setText('live-status', state.phase === 'paused' ? 'Monitoring paused' : state.phase === 'focus' ? state.message : 'Monitoring is off');
  $('live-status').dataset.warning = String(!['present', 'checking'].includes(state.reason) && state.phase === 'focus');
  $('active-app').textContent = state.appError || (state.options?.appCheck && state.phase === 'focus' ? `Active app: ${state.app.name}${state.app.title ? ` · ${state.app.title}` : ''}` : 'Active-app monitoring is off');
  $('native-audio-error').hidden = !state.audioError;
  $('native-audio-error').textContent = state.audioError || '';
  if (session?.engine === 'python' && state.sessionId === session.id) {
    const previous = session.state;
    Object.assign(session, { active: state.active, paused: state.paused, remaining: state.remaining, breakRemaining: state.breakRemaining,
      state: state.phase, observations: state.observations, reminders: state.reminders, anchor: Date.now() });
    const labels = { present: 'Estimated focused time', phone: 'Phone distraction', away: 'Away from desk',
      talking: 'Possible talking', 'looking-away': 'Looking away', 'distraction-app': 'Distracting apps / tabs' };
    $('live-stats').replaceChildren();
    for (const [key, label] of Object.entries(labels)) {
      const row = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = label; dd.textContent = minutes(state.observations[key] || 0); row.append(dt, dd); $('live-stats').append(row);
    }
    const percentage = document.createElement('p'); percentage.className = 'hint'; percentage.textContent = `Estimated focus: ${state.focusPercent}% of active session time`; $('live-stats').append(percentage);
    if (state.event && state.event.id !== lastNativeEvent && state.phase === 'focus') {
      lastNativeEvent = state.event.id;
      if (state.event.kind === 'returned') { notice(''); announce(state.event.message); }
      else notice(state.event.message, [['Keep going', () => notice('')], ['Snooze for 5 minutes', () => void nativeAction('snooze').then(() => notice(''))], ['Pause session', pauseSession]]);
    }
    if (previous !== session.state) handleTransition(previous);
    renderTimer();
    if (Date.now() - lastSavedAt > 5000) { lastSavedAt = Date.now(); persist(); }
  }
  updateSensorStatus();
  startInitialPreview();
}

async function nativeAction(action, values = {}) {
  try { return await native.control(action, values); }
  catch (error) { notice(error.message); announce(error.message); return null; }
}

async function recoverNativeSession() {
  if (controlPending) return;
  controlPending = true;
  try {
    const state = await nativeAction('recover');
    if (!state) return;
    const recovered = new Session({ task: state.task || session?.task || 'Recovered session',
      duration: state.duration || state.active + state.remaining, mode: state.options.mode });
    Object.assign(recovered, { id: state.sessionId, engine: 'python', startedAt: state.startedAt || recovered.startedAt,
      state: state.phase, active: state.active, paused: state.paused, remaining: state.remaining,
      breakRemaining: state.breakRemaining, observations: state.observations, reminders: state.reminders,
      tabCheck: state.options.appCheck, mouthCheck: state.options.mouthCheck });
    session = recovered;
    $('camera').checked = false;
    $('app-check').checked = state.options.appCheck;
    initialPreviewPending = false;
    view = state.phase === 'summary' ? 'summary' : 'session';
    if (view === 'summary') saveRecord();
    notice(''); persist(); render(); applyNativeState(state); focusHeading();
    announce('Session recovered. Camera is off. Resume when you are ready.');
  } finally { controlPending = false; }
}

function configureEngineUI() {
  const full = originalMode();
  native.active = full;
  if (!full) setText('camera-fps', '');
  if (!full) native.stopPreview($('native-camera-image'));
  $('allowed-apps-field').hidden = !full;
  $('native-camera-field').hidden = !full;
  $('calibrate-camera').hidden = full;
  $('native-camera-image').hidden = true;
  $('camera-video').hidden = full; $('camera-overlay').hidden = full;
  $('app-check').closest('label').querySelector('span').innerHTML = full
    ? 'Detect distracting apps &amp; tabs<small>YouTube, social media and games, from the active window title.</small>'
    : 'Tab-away reminders<small>Only notices this tab being hidden.</small>';
  $('camera').closest('label').querySelector('span').innerHTML = full
    ? 'Camera distraction detection<small>Phone, face, head and hands with YOLOv8 and MediaPipe.</small>'
    : 'Camera reminders<small>Browser camera models. Stops when the tab closes.</small>';
  $('privacy-hint').textContent = full ? 'Detection and camera preview stay on this computer. No video is recorded.' : 'Camera frames stay in this browser. No recording or uploads.';
  $('engine-connection').textContent = full ? native.ready ? 'Original Python engine connected · YOLOv8 + active-app detection' : 'Connecting to the original engine. Run npm run dev for full monitoring.' : 'Limited mode: browser camera models and tab-away checks only.';
  updateSensorStatus();
}
$('engine').value = session?.engine || 'python';
$('engine').addEventListener('change', async () => {
  if (session && RUNNING_STATES.includes(session.state)) { $('engine').value = session.engine || 'browser'; return; }
  monitor.stop();
  // An enable request may still be opening Python capture. Let it settle before
  // checking whether that capture needs to be released when changing engines.
  await native.pending.catch(() => {});
  if (native.ready && nativeState?.phase === 'preview') await nativeAction('end');
  $('camera').checked = originalMode(); $('app-check').checked = originalMode();
  initialPreviewPending = originalMode();
  configureEngineUI();
  if (originalMode()) void loadNativeCameras();
});

function selectedCamera() {
  const value = $('native-camera-index').value;
  return { cameraIndex: Number(value) || 0, cameraName: cameraList.find(c => String(c.index) === value)?.name || '' };
}
async function loadNativeCameras() {
  if (!native.ready) return;
  $('refresh-cameras').disabled = true;
  $('camera-list-hint').textContent = 'Looking for cameras…';
  try {
    const { cameras, source, selected } = await native.cameras();
    cameraList = cameras;
    camerasLoaded = true;
    const select = $('native-camera-index');
    select.disabled = !cameras.length;
    if (!cameras.length) {
      select.replaceChildren(new Option('No camera found', ''));
      $('camera-list-hint').textContent = 'No camera found. The timer and app detection still work. Connect a camera, then refresh.';
      return;
    }
    select.replaceChildren(...cameras.map(c => new Option(c.virtual ? `${c.name} · virtual` : c.name, String(c.index))));
    const running = ['loading', 'on'].includes(nativeState?.cameraState);
    const { camera, fallback } = running ? { camera: cameras.find(c => c.index === selected) || cameras[0], fallback: false }
      : pickCamera(cameras, preferences.cameraName, selected);
    select.value = String(camera.index);
    $('camera-list-hint').textContent = fallback ? `“${preferences.cameraName}” isn't connected, so ${camera.name} is selected.`
      : source === 'probe' ? 'Camera names are unavailable on this system, so cameras are numbered.'
      : `${cameras.length} camera${cameras.length === 1 ? '' : 's'} found.${camera.virtual ? ' Virtual cameras may show a blank image.' : ''}`;
  } catch {
    $('camera-list-hint').textContent = "Couldn't list cameras. The default camera will be used.";
  } finally { $('refresh-cameras').disabled = false; startInitialPreview(); }
}

function startInitialPreview() {
  if (!initialPreviewPending || !camerasLoaded || !nativeState || !originalMode() || !native.ready) return;
  initialPreviewPending = false;
  if (!session && !nativeState.busy && $('camera').checked && ['idle', 'preview', 'summary'].includes(nativeState.phase)) void enableCamera();
}

function drawOverlay(sample) {
  const canvas = $('camera-overlay');
  const height = Math.round(640 * $('camera-video').videoHeight / $('camera-video').videoWidth) || 480;
  canvas.width = 640; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = '#ffb110'; ctx.lineWidth = 3; ctx.fillStyle = '#ffb110';
  for (const b of sample.phones) ctx.strokeRect(b.x * 640, b.y * height, b.width * 640, b.height * height);
  for (const hand of sample.hands) for (const p of hand) { ctx.beginPath(); ctx.arc(p.x * 640, p.y * height, 2, 0, Math.PI * 2); ctx.fill(); }
}
async function listCameras() {
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    const selected = monitor.stream?.getVideoTracks()[0]?.getSettings().deviceId;
    $('camera-device').replaceChildren(...devices.map((d, i) => {
      const option = document.createElement('option'); option.value = d.deviceId; option.textContent = d.label || `Camera ${i + 1}`; return option;
    }));
    if (selected) $('camera-device').value = selected;
    $('camera-device-field').hidden = devices.length < 2;
  } catch { /* Preview and detection work without a device list. */ }
}
async function enableCamera(deviceId) {
  if (session?.state === 'paused' || session?.state === 'break') return;
  $('camera').checked = true;
  $('camera-details').open = true;
  if (originalMode()) {
    native.stopPreview($('native-camera-image'));
    if (!cameraList.length && camerasLoaded) { $('camera-message').textContent = 'No camera found. Connect a camera, then refresh the list.'; return; }
    await nativeAction(session?.state === 'focus' ? 'camera' : 'preview', { camera: true, ...selectedCamera() });
    return;
  }
  await monitor.start(deviceId);
}

function disableCamera() {
  $('camera').checked = false;
  native.stopPreview($('native-camera-image'));
  if (originalMode()) void nativeAction('camera', { camera: false });
  else monitor.stop();
}

function prepareSound() {
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    audioContext ||= new Audio();
    void audioContext.resume().catch(() => {});
  } catch { /* Text reminders remain available. */ }
}
function playSound(force = false) {
  if ((!force && preferences.mute) || !audioContext || audioContext.state !== 'running') return;
  const oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
  oscillator.type = 'sine'; oscillator.frequency.value = 660;
  gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.08, audioContext.currentTime + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.45);
  oscillator.connect(gain); gain.connect(audioContext.destination); oscillator.start(); oscillator.stop(audioContext.currentTime + 0.5);
  oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
}
function remind(kind) {
  const now = Date.now();
  if (session?.state !== 'focus' || now < snoozedUntil || now - lastReminderAt < preferences.reminderCooldown * 1000) return;
  lastReminderAt = now; session.reminders++;
  const actions = [
    ['Keep going', () => notice('')],
    ['Snooze for 5 minutes', () => { snoozedUntil = Date.now() + 300000; notice(''); announce('Reminders snoozed for 5 minutes.'); }],
    ['Pause session', pauseSession],
  ];
  if (kind === 'mouth') actions.splice(1, 0, ['Turn off mouth reminders', () => {
    session.mouthCheck = false; $('mouth-check').checked = false; tracker.reset(); notice(''); persist();
    announce('Mouth movement reminders turned off for this session.');
  }]);
  notice(reminderMessages[kind], actions);
  playSound(); persist();
}
function handleTransition(previous) {
  if (previous === session.state) return;
  closeHiddenInterval(); notice(''); tracker.reset();
  if (session.state === 'break') {
    monitor.stop(); saveRecord();
    announce('Session complete and saved. Take a 5-minute break.'); playSound();
  } else if (session.state === 'summary') {
    monitor.stop(); saveRecord(); view = 'summary';
    announce('Your session recap is ready.');
  }
  persist(); render();
}
function tick() {
  updateSensorStatus();
  if (!session || !RUNNING_STATES.includes(session.state)) return;
  if (session.engine === 'python') return; // Python owns time and stats, including while the tab is hidden.
  const previous = session.state;
  session.tick();
  handleTransition(previous);
  renderTimer();
  if (Date.now() - lastSavedAt >= 5000) { lastSavedAt = Date.now(); persist(); }
}
async function pauseSession() {
  tick();
  if (!session || session.state === 'summary') return;
  if (session.state === 'break') { endSession(); return; }
  if (session.engine === 'python') {
    if (controlPending) return;
    controlPending = true;
    try {
      if (nativeState?.sessionId !== session.id && session.state === 'paused') await nativeAction('start', nativeSessionOptions());
      else await nativeAction(session.state === 'paused' ? 'resume' : 'pause');
      if (nativeState?.sessionId === session.id) notice('');
      render(); persist();
    } finally { controlPending = false; }
    return;
  }
  session.togglePause(); tracker.reset(); notice(''); hiddenAt = null;
  if (session.state === 'paused') monitor.stop();
  else {
    prepareSound();
    if ($('camera').checked) void monitor.start($('camera-device').value);
  }
  persist(); render(); announce(session.state === 'paused' ? 'Session paused. Camera capture is off.' : 'Session resumed.');
}
async function endSession() {
  if (!session || !RUNNING_STATES.includes(session.state)) return;
  if (session.engine === 'python') {
    if (nativeState && !nativeState.busy && nativeState.sessionId !== session.id) {
      session.state = 'summary'; saveRecord(); view = 'summary'; notice(''); render(); persist(); focusHeading();
      return;
    }
    if (controlPending) return;
    controlPending = true;
    try {
      const final = await nativeAction('end');
      if (final) { view = 'summary'; render(); persist(); focusHeading(); }
    } finally { controlPending = false; }
    return;
  }
  // Account for a final hidden interval before freezing the record.
  closeHiddenInterval();
  session.end(); monitor.stop(); tracker.reset(); notice('');
  saveRecord(); view = 'summary'; persist(); render(); focusHeading();
  announce('Session ended and saved. Your recap is ready.');
}

function nativeSessionOptions() {
  return { sessionId: session.id, task: session.task, duration: session.duration, startedAt: session.startedAt,
    remaining: session.remaining, active: session.active, paused: session.paused, reminderCooldown: preferences.reminderCooldown,
    observations: session.observations, reminders: session.reminders,
    camera: $('camera').checked && $('native-camera-index').value !== '', appCheck: $('app-check').checked, mouthCheck: $('mouth-check').checked,
    mute: preferences.mute, mode: session.mode, ...selectedCamera(),
    allowedApps: $('allowed-apps').value.split(',').map(s => s.trim()).filter(Boolean) };
}
$('session-form').addEventListener('submit', async event => {
  event.preventDefault();
  const task = $('task').value.trim();
  if (!task) { $('task-error').hidden = false; $('task').setAttribute('aria-invalid', 'true'); $('task').focus(); return; }
  $('task-error').hidden = true; $('task').removeAttribute('aria-invalid');
  if (controlPending) return;
  session = new Session({ task, duration: Number($('duration').value) * 60, mode: $('mode').value, tabCheck: $('app-check').checked, mouthCheck: $('mouth-check').checked });
  session.engine = originalMode() ? 'python' : 'browser';
  if (originalMode()) {
    controlPending = true;
    const submit = document.querySelector('#session-form button[type=submit]'); submit.disabled = true;
    const started = await nativeAction('start', nativeSessionOptions());
    controlPending = false; submit.disabled = false;
    if (!started) { session = null; return; }
    lastNativeEvent = 0;
  }
  summaryRecord = null; snoozedUntil = 0; lastReminderAt = -Infinity; tabAwaySeconds = 0; hiddenAt = null; tracker.reset();
  view = 'session'; notice(''); prepareSound(); persist(); render(); focusHeading();
  if (!originalMode() && $('camera').checked && !['starting', 'loading', 'on'].includes(monitor.state)) void monitor.start($('camera-device').value);
  announce('Session started.');
});
$('pause').addEventListener('click', pauseSession);
$('end').addEventListener('click', endSession);
$('mode').addEventListener('change', () => { $('mouth-check').disabled = $('mode').value === 'lecture'; render(); });
$('enable-camera').addEventListener('click', () => void enableCamera($('camera-device').value));
$('stop-camera').addEventListener('click', () => { disableCamera(); announce('Camera off.'); });
$('camera').addEventListener('change', () => {
  if ($('camera').checked) void enableCamera($('camera-device').value); else disableCamera();
});
$('refresh-cameras').addEventListener('click', () => void loadNativeCameras());
$('native-camera-index').addEventListener('change', () => {
  preferences.cameraName = selectedCamera().cameraName; persist();
  if ($('camera').checked) void enableCamera();
});
$('camera-device').addEventListener('change', () => void enableCamera($('camera-device').value));
$('calibrate-camera').addEventListener('click', () => { monitor.calibrate(); tracker.reset(); announce('Look toward the camera for a few seconds.'); });
$('app-check').addEventListener('change', updateSensorStatus);
$('camera').addEventListener('change', updateSensorStatus);
$('mouth-check').addEventListener('change', updateSensorStatus);
$('new-session').addEventListener('click', () => {
  session = null; summaryRecord = null; view = 'ready'; $('camera').checked = false;
  monitor.stop(); notice(''); persist(); render(); focusHeading();
});
function saveNote() {
  if (!summaryRecord) return;
  summaryRecord.note = $('reflection').value.trim().slice(0, 5000);
  const ok = persist();
  $('saved-note').textContent = ok ? 'Note saved in this browser.' : 'This note could not be saved. Copy it before closing the page.';
}
$('reflection').maxLength = 5000;
$('reflection').addEventListener('input', saveNote);
$('save-note').addEventListener('click', saveNote);
function openHistory() {
  if (session && RUNNING_STATES.includes(session.state)) { announce('End your current session before opening history.'); return; }
  monitor.stop(); notice(''); view = 'history'; render(); focusHeading();
}
$('nav-history').addEventListener('click', openHistory);
$('view-all-history').addEventListener('click', openHistory);
$('nav-focus').addEventListener('click', () => {
  notice(''); view = session && RUNNING_STATES.includes(session.state) ? 'session' : 'ready'; render(); focusHeading();
});
$('export-history').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), sessions: history }, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `studybuddy-sessions-${new Date().toISOString().slice(0, 10)}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000); announce('History exported.');
});
$('import-history').addEventListener('click', () => $('history-file').click());
$('history-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error('Choose a backup smaller than 10 MB.');
    const result = importHistory(await file.text(), history);
    // Save the proposed merge before replacing the displayed history.
    if (!save({ history: result.history, current: session && RUNNING_STATES.includes(session.state) ? session.record() : null, preferences })) {
      throw new Error('The backup could not be saved. Free browser storage and try again. Your existing history was kept.');
    }
    history = result.history; render();
    $('import-status').textContent = result.added ? `Imported ${result.added} session${result.added === 1 ? '' : 's'}. The most recent 500 are kept.`
      : 'These sessions are already in your history. Existing notes were kept.';
    announce($('import-status').textContent);
  } catch (error) { $('import-status').textContent = error.message; announce(error.message); }
});
$('clear-history').addEventListener('click', () => { $('clear-confirm').hidden = false; $('cancel-clear').focus(); });
$('cancel-clear').addEventListener('click', () => { $('clear-confirm').hidden = true; $('clear-history').focus(); });
$('confirm-clear').addEventListener('click', () => {
  history = []; summaryRecord = null; session = null; persist(); render(); focusHeading(); announce('Session history cleared from this browser.');
});
$('theme').value = preferences.theme;
$('mute').checked = preferences.mute;
$('reminder-cooldown').value = String(preferences.reminderCooldown);
$('reminder-cooldown').addEventListener('change', () => {
  preferences.reminderCooldown = Number($('reminder-cooldown').value);
  if (originalMode() && native.ready) void nativeAction('settings', { reminderCooldown: preferences.reminderCooldown });
  persist(); announce('Reminder interval saved.');
});
function applyTheme() {
  const theme = preferences.theme === 'system' ? (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light') : preferences.theme;
  $('app').dataset.theme = theme; document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme;
}
$('theme').addEventListener('change', () => { preferences.theme = $('theme').value; applyTheme(); persist(); });
matchMedia('(prefers-color-scheme:dark)').addEventListener('change', applyTheme);
$('mute').addEventListener('change', () => { preferences.mute = $('mute').checked; if (originalMode() && native.ready) void nativeAction('settings', { mute: preferences.mute }); prepareSound(); persist(); });
$('test-sound').addEventListener('click', async () => {
  if (originalMode()) { await nativeAction('sound'); return; }
  prepareSound();
  if (audioContext) await audioContext.resume().catch(() => {});
  playSound(true); announce('Playing a quiet reminder tone.');
});
$('open-settings').addEventListener('click', () => $('settings').showModal());
$('close-settings').addEventListener('click', () => { $('settings').close(); render(); announce('Preferences saved.'); });

function closeHiddenInterval() {
  if (hiddenAt === null || !session) return;
  // Cap at the session's scheduled finish when background timers were throttled.
  const seconds = Math.max(0, (Math.min(Date.now(), hiddenUntil) - hiddenAt) / 1000);
  session.observations.tab = (session.observations.tab || 0) + seconds;
  tabAwaySeconds = seconds; hiddenAt = null; hiddenUntil = null;
}
function syncNativePreview() {
  if (originalMode() && nativeState && !nativeState.busy && nativeState.cameraState === 'on' && $('camera').checked && $('camera-details').open && !document.hidden) {
    void native.preview($('native-camera-image'));
  } else native.stopPreview($('native-camera-image'));
}
$('camera-details').addEventListener('toggle', syncNativePreview);
document.addEventListener('visibilitychange', () => {
  if (originalMode()) { syncNativePreview(); return; } // Only display pauses; Python detection keeps running.
  if (document.hidden) {
    tick(); tracker.reset();
    if (session?.state === 'focus' && session.tabCheck) { hiddenAt = Date.now(); hiddenUntil = hiddenAt + session.remaining * 1000; }
  } else {
    closeHiddenInterval(); tick(); tracker.reset();
    if (tabAwaySeconds >= 15) remind('tab');
    tabAwaySeconds = 0;
  }
  persist();
});
window.addEventListener('pagehide', () => {
  if (originalMode()) { native.leave(); if (session?.state === 'focus') session.state = 'paused'; persist(); return; }
  closeHiddenInterval(); tick();
  if (session?.state === 'focus') session.togglePause();
  persist(); monitor.stop();
});
window.addEventListener('pageshow', event => {
  if (event.persisted) {
    $('camera').checked = false;
    if (session) session.anchor = Date.now();
    tracker.reset(); render();
    announce('Your session is paused. Camera is off. Resume when you are ready.');
  }
});

if (!saved.current && !saved.hasSavedData) { preferences.mute = false; $('mute').checked = false; }
configureEngineUI(); applyTheme(); render();
showStorage(saved.storageAvailable);
if (session) announce('Your saved session is ready. Camera is off. Resume when you are ready.');
setInterval(tick, 250);
void native.poll();
