export class CameraMonitor {
  constructor(video, { onState, onSample }) {
    this.video = video;
    this.onState = onState;
    this.onSample = onSample;
    this.generation = 0;
    this.state = 'off';
    this.stream = null;
    this.worker = null;
    this.timer = null;
  }

  setState(state, message) {
    this.state = state;
    this.onState(state, message);
  }

  async start(deviceId) {
    this.stop();
    const generation = this.generation;
    this.setState('starting', 'Waiting for camera permission…');
    try {
      if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error('Camera access needs HTTPS or localhost. You can still use the timer.');
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user',
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
      });
      if (generation !== this.generation) { stream.getTracks().forEach(t => t.stop()); return false; }
      this.stream = stream;
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        if (generation === this.generation) this.fail('Camera disconnected. Check the connection, then try again.');
      });
      this.video.srcObject = stream;
      await this.video.play();
      if (generation !== this.generation) return false;
      if (!globalThis.OffscreenCanvas || !globalThis.createImageBitmap) {
        throw new Error('This browser can show a camera preview but cannot run these camera models. Try a current Chrome, Edge, Firefox, or Safari.');
      }
      this.setState('loading', 'Loading camera models on this device…');
      this.worker = new Worker(new URL('../vision-worker.js', document.baseURI));
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Camera models took too long to load. Try again, or continue with the timer.')), 60000);
        this.cancelLoading = () => { clearTimeout(timeout); reject(new Error('Cancelled')); };
        this.worker.onerror = () => { clearTimeout(timeout); reject(new Error('Camera processing could not start. Run npm run models, then reload.')); };
        this.worker.onmessage = ({ data }) => {
          if (generation !== this.generation) return;
          if (data.type === 'ready') { clearTimeout(timeout); this.cancelLoading = null; resolve(); }
          else if (data.type === 'progress') this.setState('loading', data.message);
          else if (data.type === 'error') { clearTimeout(timeout); reject(new Error(data.message)); }
        };
        this.worker.postMessage({ type: 'init', base: new URL('./', document.baseURI).href });
      });
      if (generation !== this.generation) return false;
      this.worker.onmessage = ({ data }) => {
        if (generation !== this.generation) return;
        if (data.type === 'result') {
          clearTimeout(this.inferenceTimeout);
          this.onSample(data.sample);
          this.scheduleFrame(generation);
        } else if (data.type === 'error') this.fail('Camera detection stopped. You can retry or keep using the timer.');
      };
      this.worker.onerror = () => this.fail('Camera detection stopped. You can retry or keep using the timer.');
      this.setState('on', 'Camera reminders on. Look toward the camera briefly to calibrate.');
      this.scheduleFrame(generation);
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      const messages = {
        NotAllowedError: 'Camera permission was not granted. Allow it in your browser’s site settings, then try again. The timer still works.',
        NotFoundError: 'No camera found. Connect a camera, or continue with the timer.',
        NotReadableError: 'The camera is busy or unavailable. Close other camera apps, then try again.',
        OverconstrainedError: 'That camera is unavailable. Choose another camera, then try again.',
      };
      this.fail(messages[error.name] || error.message);
      return false;
    }
  }

  scheduleFrame(generation) {
    this.timer = setTimeout(async () => {
      if (generation !== this.generation || this.state !== 'on') return;
      if (document.hidden || this.video.readyState < 2) { this.scheduleFrame(generation); return; }
      try {
        const image = await createImageBitmap(this.video, { resizeWidth: 640, resizeQuality: 'low' });
        if (generation !== this.generation) { image.close(); return; }
        this.inferenceTimeout = setTimeout(() => this.fail('Camera detection stopped responding. Try again, or use the timer.'), 15000);
        this.worker.postMessage({ type: 'frame', image, timestamp: performance.now() }, [image]);
      } catch { if (generation === this.generation) this.fail('We could not read a camera frame. Try the camera again.'); }
    }, 400);
  }

  calibrate() { this.worker?.postMessage({ type: 'calibrate' }); }

  fail(message) {
    this.stop();
    this.setState('error', message);
  }

  stop() {
    this.generation++;
    clearTimeout(this.timer);
    clearTimeout(this.inferenceTimeout);
    this.cancelLoading?.();
    this.cancelLoading = null;
    this.worker?.terminate();
    this.worker = null;
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.setState('off', 'Camera off. Your timer works with or without it.');
  }
}
