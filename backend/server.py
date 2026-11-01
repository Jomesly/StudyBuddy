import secrets
import asyncio
import struct
from contextlib import asynccontextmanager
from typing import Literal
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field
from .cameras import directshow_names, list_cameras
from .engine import Engine

TOKEN = secrets.token_urlsafe(32)
camera_names = directshow_names  # Replaced in tests; no real device is enumerated there.
engine = Engine()
ALLOWED_ORIGINS = {f'http://{host}:{port}' for host in ('localhost', '127.0.0.1') for port in (5174, 4173, 8766)}


@asynccontextmanager
async def lifespan(app):
    engine.start_workers()
    yield
    engine.close()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware('http')
async def protect_local_engine(request: Request, call_next):
    if request.headers.get('origin') and request.headers['origin'] not in ALLOWED_ORIGINS:
        return JSONResponse({'detail': 'Untrusted origin'}, status_code=403)
    if request.headers.get('host', '').split(':')[0] not in ('localhost', '127.0.0.1', 'testserver'):
        return JSONResponse({'detail': 'Untrusted host'}, status_code=403)
    response = await call_next(request)
    response.headers['Cache-Control'] = 'no-store'
    return response


def authorize(request):
    if not secrets.compare_digest(request.headers.get('x-studybuddy-key', request.headers.get('x-focusbuddy-key', '')), TOKEN):
        raise HTTPException(403, 'Local engine authorization required')
    owner = request.headers.get('x-studybuddy-client', request.headers.get('x-focusbuddy-client', ''))
    if not 8 <= len(owner) <= 100:
        raise HTTPException(400, 'Client identifier required')
    return owner


class Control(BaseModel):
    action: Literal['start', 'preview', 'pause', 'resume', 'end', 'camera', 'settings', 'snooze', 'sound', 'release', 'recover']
    sessionId: str = Field(default='', max_length=100)
    task: str = Field(default='Recovered session', max_length=100)
    duration: float = Field(default=1500, gt=0, le=10800)
    startedAt: str = Field(default='', max_length=40)
    remaining: float = Field(default=1500, gt=0, le=10800)
    active: float = Field(default=0, ge=0, le=10800)
    paused: float = Field(default=0, ge=0, le=86400)
    reminders: int = Field(default=0, ge=0, le=100000)
    observations: dict[str, float] = Field(default_factory=dict)
    camera: bool = False
    appCheck: bool = True
    mouthCheck: bool = True
    mute: bool = False
    reminderCooldown: Literal[5, 30, 60, 120] = 60
    mode: Literal['screen', 'paper', 'lecture'] = 'screen'
    cameraIndex: int = Field(default=0, ge=0, le=31)
    cameraName: str = Field(default='', max_length=120)
    allowedApps: list[str] = Field(default_factory=list, max_length=30)


@app.get('/api/health')
def health():
    return {'service': 'studybuddy-python', 'protocol': 1, 'key': TOKEN,
            'model': 'yolov8n.pt', 'features': ['phone', 'face', 'head', 'hands', 'talking', 'active-window', 'background-alerts']}


@app.get('/api/state')
def state(request: Request):
    return engine.snapshot(authorize(request))


@app.post('/api/control')
def control(body: Control, request: Request):
    owner = authorize(request)
    data = body.model_dump(exclude_unset=True)
    if body.action == 'start':
        if not body.sessionId:
            raise HTTPException(400, 'Session identifier required')
        data = body.model_dump()
    if any(len(word) > 100 for word in body.allowedApps):
        raise HTTPException(400, 'Allowed app names must be 100 characters or shorter')
    if body.action in ('start', 'preview', 'camera') and 'cameraIndex' in data and (body.camera or body.action == 'preview'):
        found = list_cameras(names=camera_names, prober=lambda busy: [])
        # Probing would open devices, so only DirectShow (name-only) results are used to reject an index.
        if found['source'] == 'directshow' and body.cameraIndex not in {c['index'] for c in found['cameras']}:
            raise HTTPException(409, f"Camera {body.cameraIndex} isn't connected. Refresh the camera list and choose another camera.")
    try:
        return engine.control(body.action, owner, data)
    except ValueError as error:
        raise HTTPException(409, str(error)) from error


@app.get('/api/cameras')
def cameras(request: Request):
    authorize(request)
    with engine.lock:
        busy = engine.options['cameraIndex'] if engine.camera_state in ('loading', 'on') else None
        selected = engine.options['cameraIndex']
    return {**list_cameras(busy=busy, names=camera_names), 'selected': selected}


@app.get('/api/frame')
def frame(request: Request):
    owner = authorize(request)
    with engine.lock:
        if engine.owner != owner:
            raise HTTPException(403, 'This camera belongs to another tab')
        data = engine.jpeg
    return Response(data, media_type='image/jpeg') if data else Response(status_code=204)


async def preview_frames(source, owner, epoch):
    """Length-prefixed JPEGs; one latest frame, no per-client frame queue."""
    previous = None
    while not source.closing.is_set():
        with source.lock:
            if source.owner != owner or not source.wants_camera() or source.camera_epoch != epoch:
                return
            sequence, jpeg = source.frame_sequence, source.jpeg
            if source.camera_state == 'error':
                return
        if jpeg and sequence != previous:
            previous = sequence
            yield struct.pack('!I', len(jpeg)) + jpeg
        await asyncio.sleep(.004)


@app.get('/api/stream')
def stream(request: Request):
    owner = authorize(request)
    with engine.lock:
        if engine.owner != owner:
            raise HTTPException(403, 'This camera belongs to another tab')
        epoch = engine.camera_epoch
    return StreamingResponse(preview_frames(engine, owner, epoch),
                             media_type='application/x-studybuddy-jpeg-stream',
                             headers={'X-Accel-Buffering': 'no'})


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=8766, access_log=False)
