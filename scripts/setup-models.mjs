import { cp, mkdir, stat, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
await mkdir(new URL('public/models/', root), { recursive: true });
await cp(new URL('node_modules/@mediapipe/tasks-vision/wasm/', root), new URL('public/wasm/', root), { recursive: true });
const models = {
  'face_landmarker.task': 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  'hand_landmarker.task': 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  'efficientdet_lite0.tflite': 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/1/efficientdet_lite0.tflite',
};
for (const [name, url] of Object.entries(models)) {
  const dest = new URL(`public/models/${name}`, root);
  if (await stat(dest).then(s => s.size > 100000, () => false)) continue;
  console.log(`Downloading ${name} from Google MediaPipe…`);
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Model download failed (${response.status}). Run npm run models to retry.`);
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.length < 100000) throw new Error(`Incomplete model: ${name}`);
  const temp = fileURLToPath(dest) + '.download';
  await writeFile(temp, data);
  await rename(temp, dest);
}
console.log('Camera models and WebAssembly are ready. They are served locally; no camera frames are uploaded.');
