"""Check engine dependencies without opening cameras or audio devices."""
import sys


def check_runtime():
    if sys.version_info[:2] != (3, 11):
        raise RuntimeError('The detection engine needs Python 3.11. Create its environment with Python 3.11 and retry.')
    import cv2
    import mediapipe as mp
    import pygame
    from ultralytics import YOLO
    import fastapi
    import uvicorn
    if not hasattr(mp, 'solutions') or not hasattr(mp.solutions, 'face_mesh'):
        raise RuntimeError('The detector needs the legacy MediaPipe solutions API from mediapipe==0.10.14.')
    if not callable(cv2.VideoCapture) or not callable(YOLO):
        raise RuntimeError('OpenCV or the YOLO detector could not be loaded.')
    if sys.platform == 'win32':
        import pygetwindow
        from pygrabber.dshow_graph import FilterGraph


if __name__ == '__main__':
    try:
        check_runtime()
    except Exception as error:
        print(f'Engine dependency check failed: {error}', file=sys.stderr)
        sys.exit(1)
