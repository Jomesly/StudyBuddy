"""Camera discovery. Windows lists DirectShow names in the same order OpenCV's CAP_DSHOW indexes them."""
import re
import sys

VIRTUAL = re.compile(r'virtual|obs|snap camera|nvidia broadcast|xsplit|manycam|droidcam|iriun|camo|splitcam', re.I)
PROBE_LIMIT = 6


def directshow_names():
    """Return DirectShow video input names, or None when pygrabber/COM is unavailable."""
    if sys.platform != 'win32':
        return None
    try:
        import comtypes
        from pygrabber.dshow_graph import FilterGraph
    except ImportError:
        return None
    comtypes.CoInitialize()  # FastAPI runs sync endpoints on worker threads.
    try:
        return list(FilterGraph().get_input_devices())
    except Exception:
        return None
    finally:
        comtypes.CoUninitialize()


def probe_indices(busy=None, limit=PROBE_LIMIT):
    """Fallback without names: open each index briefly. Never touches the camera the engine holds."""
    import cv2
    found = []
    for index in range(limit):
        if index == busy:
            found.append(index)
            continue
        capture = cv2.VideoCapture(index, cv2.CAP_ANY)
        try:
            if capture.isOpened():
                found.append(index)
        finally:
            capture.release()
    return found


def describe(names):
    seen, cameras = {}, []
    for index, raw in enumerate(names):
        name = (raw or '').strip() or f'Camera {index}'
        seen[name] = seen.get(name, 0) + 1
        label = name if seen[name] == 1 else f'{name} ({seen[name]})'
        cameras.append({'index': index, 'name': label, 'virtual': bool(VIRTUAL.search(name))})
    return cameras


def list_cameras(busy=None, names=directshow_names, prober=probe_indices):
    found = names()
    if found is not None:
        return {'cameras': describe(found), 'source': 'directshow'}
    return {'cameras': [{'index': i, 'name': f'Camera {i}', 'virtual': False} for i in prober(busy)], 'source': 'probe'}
