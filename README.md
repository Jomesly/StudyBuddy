# StudyBuddy

A local study workspace with a session timer, camera preview, and optional distraction reminders. The dashboard keeps the timer and camera side by side, with monitoring settings and session history available when needed.

## Getting started

Install **Node.js 22.12 or later** and **Python 3.11**. Windows is required for foreground application monitoring and named DirectShow camera selection. Run these commands from the project folder:

```powershell
npm install
npm run dev
```

Open **http://127.0.0.1:5174/**. Keep the terminal running; **Ctrl+C** stops both the website and the Python engine. Subsequent launches only need `npm run dev`.

The launcher uses `venv` if present, otherwise creates `.venv-web` and installs `requirements.txt`. On Windows, Python 3.11 must be available through `py -3.11`. On other platforms the launcher uses `python3`; use Python 3.11 for compatibility with the pinned MediaPipe package.

The first installation needs internet access to download browser models and dependencies. The Python detector downloads the standard `yolov8n.pt` model through Ultralytics when first loaded if it is absent. Model weights, virtual environments, and generated assets are not committed. If a browser model download fails, run `npm run models` to retry.

## Monitoring modes

| Capability | Original Python | Browser only |
| --- | --- | --- |
| Timer, notes, history, and export | Yes | Yes |
| Face presence, head direction, hands | Local MediaPipe | Local MediaPipe worker |
| Phone detection | YOLOv8 | EfficientDet Lite |
| Mouth movement observation | Optional heuristic | Optional heuristic |
| Foreground application titles | Windows | Unavailable |
| Monitoring while another tab is active | Local engine continues | Tab-away reminders; camera analysis suspends |

**Original Python** is the default. `npm run dev` starts both services and checks the engine through the same `/api/health` proxy used by the page. No `.env` file or second terminal is needed. The local engine listens on `127.0.0.1:8766`; the website uses port `5174`.

Enable the camera to see a preview before starting a session. Camera controls support turning capture off and on and switching devices. Capture and inference run separately in Python mode so a slow detector does not limit preview refresh to its analysis rate. Delivered FPS depends on the camera, lighting, and driver.

Pause, end, or start a break to release capture. Resume restores it only if enabled for the current visit. Recovered sessions open paused with the camera off. A single browser tab owns the active local session.

**Browser only** is an optional fallback. `npm run dev:web` serves the website without starting Python; select Browser only in the app. Camera access requires localhost or HTTPS and browser permission. Current Chrome or Edge is recommended; other browsers and mobile background behavior require device testing.

## Privacy and limitations

Camera frames are processed locally, with no cloud video upload or recording. In Python mode, previews travel only between the local engine and the browser. Foreground application checks read window titles on Windows. Session history, notes, and preferences are stored in this browser and can be exported or deleted. There is no account or cloud synchronization.

Distraction detection is heuristic. Lighting, camera position, occlusion, and device performance affect results. Mouth movement does not establish speech; no microphone is used. Active session time is not a measurement of proven focus.

## Build and test

```powershell
npm test
npm run test:e2e
npm run build
```

For Python tests, use the environment selected by the launcher:

```powershell
.\venv\Scripts\python.exe -m unittest discover -s tests/python -v
# If the launcher created .venv-web instead:
.\.venv-web\Scripts\python.exe -m unittest discover -s tests/python -v
```

Browser tests use installed Google Chrome through Playwright. Install Chrome before running them, or configure Playwright to use its bundled Chromium. The test suite covers timer accounting, storage, engine connectivity, camera lifecycle, device selection, and preview behavior. Worker changes are compiled before `dev` and `build`; restart the development server after editing worker code.

`npm run preview` serves the production build at **http://127.0.0.1:4173/** and does not launch Python. Static hosting can provide Browser only mode over HTTPS; the full Python engine requires a local service. The local engine is restricted to loopback hosts and supported local origins. Public hosting of that service is not configured.

## Project structure

- `src/`: dashboard, session state, storage, monitoring clients, and browser vision worker.
- `backend/`: local FastAPI service, camera capture, detector, and foreground application checks.
- `scripts/`: development launcher and browser model/worker setup.
- `tests/`: JavaScript, Python, and Playwright checks.
- `study_monitor.py`: original OpenCV desktop version, run with the Python environment after installing requirements.
- `test_phone.py`, `yolov3.cfg`, and `coco.names`: earlier YOLOv3 experiment; running it also requires separately obtained `yolov3.weights` in the project root.

## Design and dependencies

See [DESIGN.md](DESIGN.md) for the current visual system. The interface bundles Inter through `@fontsource-variable/inter`. Font license notices are retained alongside bundled assets.

The Python detector uses [Ultralytics](https://github.com/ultralytics/ultralytics), which has AGPL-3.0 and commercial licensing options. Browser detection uses [MediaPipe](https://github.com/google-ai-edge/mediapipe), distributed under Apache-2.0. Model downloads use the versioned sources in `scripts/setup-models.mjs` and Ultralytics' standard asset downloader. Dependency and model licenses apply to redistribution; these dependencies do not establish a license for the project's own code.
