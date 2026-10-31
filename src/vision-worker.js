import { FaceLandmarker, HandLandmarker, ObjectDetector, FilesetResolver } from '@mediapipe/tasks-vision';
import { geometry, headDirection } from './observations.mjs';

let face, hands, objects, baseline = null, calibration = [];

async function initialize(base) {
  const files = await FilesetResolver.forVisionTasks(`${base}wasm`);
  const options = name => ({
    baseOptions: { modelAssetPath: `${base}models/${name}`, delegate: 'CPU' },
    runningMode: 'VIDEO',
    canvas: new OffscreenCanvas(640, 480),
  });
  self.postMessage({ type: 'progress', message: 'Loading face detection…' });
  face = await FaceLandmarker.createFromOptions(files, { ...options('face_landmarker.task'), numFaces: 1 });
  self.postMessage({ type: 'progress', message: 'Loading hand detection…' });
  hands = await HandLandmarker.createFromOptions(files, { ...options('hand_landmarker.task'), numHands: 2 });
  self.postMessage({ type: 'progress', message: 'Loading phone detection…' });
  objects = await ObjectDetector.createFromOptions(files, {
    ...options('efficientdet_lite0.tflite'), scoreThreshold: 0.45,
    categoryAllowlist: ['cell phone'], maxResults: 3,
  });
  self.postMessage({ type: 'ready' });
}

function analyze(image, timestamp) {
  try {
    const faceResult = face.detectForVideo(image, timestamp);
    const handResult = hands.detectForVideo(image, timestamp);
    const objectResult = objects.detectForVideo(image, timestamp);
    const landmarks = faceResult.faceLandmarks[0];
    const pose = landmarks ? geometry(landmarks) : null;
    if (pose && !baseline) {
      calibration.push(pose);
      if (calibration.length >= 6) {
        const median = key => calibration.map(p => p[key]).sort((a, b) => a - b)[3];
        baseline = { horizontal: median('horizontal'), vertical: median('vertical') };
      }
    }
    const phones = objectResult.detections.map(({ boundingBox: b, categories }) => ({
      x: b.originX / image.width, y: b.originY / image.height,
      width: b.width / image.width, height: b.height / image.height,
      score: categories[0].score,
    }));
    const phoneNearHand = phones.some(b => handResult.landmarks.some(hand => hand.some(p =>
      p.x >= b.x - 0.06 && p.x <= b.x + b.width + 0.06 &&
      p.y >= b.y - 0.06 && p.y <= b.y + b.height + 0.06)));
    self.postMessage({ type: 'result', sample: {
      facePresent: !!landmarks, direction: pose ? headDirection(pose, baseline) : 'unknown',
      mouthOpen: pose?.mouthOpen ?? false, phoneVisible: phones.length > 0, phoneNearHand,
      phones, hands: handResult.landmarks, calibrated: !!baseline,
    } });
  } finally { image.close(); }
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') await initialize(data.base);
    else if (data.type === 'frame') analyze(data.image, data.timestamp);
    else if (data.type === 'calibrate') { baseline = null; calibration = []; }
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message || 'Camera processing failed.' });
  }
};
