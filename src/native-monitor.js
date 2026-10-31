import { jpegFrames } from './jpeg-stream.mjs';

export class NativeMonitor {
  constructor({ onState, onConnection }) {
    this.onState = onState;
    this.onConnection = onConnection;
    // Blocked storage must not stop the app; the client id then lasts for this page only.
    try { this.client = sessionStorage.getItem('studybuddy.client') || sessionStorage.getItem('focusbuddy.client'); } catch { this.client = null; }
    this.client ||= crypto.randomUUID();
    try { sessionStorage.setItem('studybuddy.client', this.client); } catch { /* Page-lifetime id is enough. */ }
    this.key = null;
    this.headerPrefix = 'X-StudyBuddy';
    this.ready = false;
    this.active = true;
    this.pending = Promise.resolve();
    this.previewUrl = null;
    this.state = null;
  }
  headers() { return { 'Content-Type': 'application/json', [`${this.headerPrefix}-Key`]: this.key || '', [`${this.headerPrefix}-Client`]: this.client }; }
  async connect() {
    try {
      const response = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
      const health = await response.json();
      if (!response.ok || !['studybuddy-python', 'focusbuddy-python'].includes(health.service) || health.protocol !== 1) throw new Error('Unavailable');
      this.headerPrefix = health.service === 'studybuddy-python' ? 'X-StudyBuddy' : 'X-FocusBuddy';
      this.key = health.key; this.ready = true;
      this.onConnection(true, 'Original Python engine connected · YOLOv8 + active-app detection');
      return true;
    } catch {
      this.ready = false;
      this.onConnection(false, 'Original engine is not connected. Start npm run dev, or explicitly choose Browser only for limited monitoring.');
      return false;
    }
  }
  async request(action, values = {}, keepalive = false) {
    if (!this.ready && !await this.connect()) throw new Error('The original Python engine is not connected. Run npm run dev first.');
    const response = await fetch('/api/control', { method: 'POST', headers: this.headers(),
      body: JSON.stringify({ action, ...values }), keepalive, signal: keepalive ? undefined : AbortSignal.timeout(10000) });
    const state = await response.json();
    if (!response.ok) throw new Error(typeof state.detail === 'string' ? state.detail : 'The original engine could not apply this change.');
    this.state = state; this.onState(state);
    return state;
  }
  async cameras() {
    if (!this.ready && !await this.connect()) throw new Error('The original Python engine is not connected.');
    const response = await fetch('/api/cameras', { headers: this.headers(), signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('Camera list unavailable');
    return response.json();
  }
  control(action, values = {}) {
    const next = this.pending.catch(() => {}).then(() => this.request(action, values));
    this.pending = next;
    return next;
  }
  async poll() {
    try {
      if (this.active) {
        if (!this.ready) await this.connect();
        if (this.ready) {
          let response = await fetch('/api/state', { headers: this.headers(), cache: 'no-store', signal: AbortSignal.timeout(3000) });
          // Restarting Python rotates its key. Reauthenticate once immediately
          // rather than showing "offline" while a healthy engine is running.
          if (response.status === 403 && await this.connect()) {
            response = await fetch('/api/state', { headers: this.headers(), cache: 'no-store', signal: AbortSignal.timeout(3000) });
          }
          if (!response.ok) throw new Error('Disconnected');
          this.state = await response.json(); this.onState(this.state);
        }
      }
    } catch {
      this.ready = false;
      this.onConnection(false, 'Connection to the Python engine was lost. Monitoring status cannot be confirmed. Check the terminal.');
    } finally { this.timer = setTimeout(() => void this.poll(), this.ready ? 500 : 3000); }
  }
  async preview(image) {
    if (!this.ready || !this.active || this.state?.cameraState !== 'on' || this.previewController) return;
    const controller = new AbortController();
    this.previewController = controller;
    try {
      const response = await fetch('/api/stream', { headers: this.headers(), signal: controller.signal });
      if (!response.ok || !response.body) return;
      for await (const bytes of jpegFrames(response.body)) {
        if (controller.signal.aborted) break;
        const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
        const previous = this.previewUrl;
        this.previewUrl = url;
        image.src = url;
        try { await image.decode(); } catch { /* Stop/switch can interrupt decoding. */ }
        if (previous) URL.revokeObjectURL(previous);
      }
    } catch { /* The state polling reports connection problems. */ }
    finally {
      if (this.previewController === controller) this.previewController = null;
    }
  }
  stopPreview(image) {
    this.previewController?.abort();
    this.previewController = null;
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = null;
    image?.removeAttribute('src');
  }
  leave() {
    this.stopPreview();
    if (this.active && this.ready) void this.request('pause', {}, true).catch(() => {});
  }
}
