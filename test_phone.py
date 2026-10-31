import cv2
import pygame
import mediapipe as mp
import time
import pygetwindow as gw
import numpy as np
from collections import deque

# === Face Detection + Mesh Initialization ===
mp_face_mesh = mp.solutions.face_mesh
mp_face_detection = mp.solutions.face_detection

face_mesh = mp_face_mesh.FaceMesh(min_detection_confidence=0.5, min_tracking_confidence=0.5)
face_detector = mp_face_detection.FaceDetection(min_detection_confidence=0.5)

# === Audio Setup ===
pygame.mixer.init()

def load_sound(filename):
    try:
        return pygame.mixer.Sound(filename)
    except:
        print(f"⚠ {filename} not found")
        return None

sound_go_back = load_sound("go_back.mp3")
sound_alert = load_sound("alert.mp3")

def play_sound(sound):
    if sound and not pygame.mixer.get_busy():
        sound.play()

# === YOLO Model Load ===
try:
    print("Loading YOLO model...")
    net = cv2.dnn.readNet("yolov3.weights", "yolov3.cfg")
    net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
    net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)

    with open("coco.names", "r") as f:
        classes = [line.strip() for line in f.readlines()]

    layer_names = net.getLayerNames()
    output_layers = [layer_names[i - 1] for i in net.getUnconnectedOutLayers()]
    yolo_available = True
    print("✅ YOLO loaded successfully")
except Exception as e:
    yolo_available = False
    print(f"⚠ YOLO not available: {e}")

# === Helper Functions ===
def get_active_window_title():
    try:
        win = gw.getActiveWindow()
        return win.title if win else "Unknown"
    except:
        return "Unknown"

def get_head_pose(landmarks, frame_w, frame_h):
    try:
        image_points = np.array([
            (landmarks[1].x * frame_w, landmarks[1].y * frame_h),
            (landmarks[199].x * frame_w, landmarks[199].y * frame_h),
            (landmarks[33].x * frame_w, landmarks[33].y * frame_h),
            (landmarks[263].x * frame_w, landmarks[263].y * frame_h),
            (landmarks[61].x * frame_w, landmarks[61].y * frame_h),
            (landmarks[291].x * frame_w, landmarks[291].y * frame_h)
        ], dtype="double")

        model_points = np.array([
            (0.0, 0.0, 0.0),
            (0.0, -330.0, -65.0),
            (-225.0, 170.0, -135.0),
            (225.0, 170.0, -135.0),
            (-150.0, -150.0, -125.0),
            (150.0, -150.0, -125.0)
        ])

        focal_length = frame_w
        center = (frame_w / 2, frame_h / 2)
        camera_matrix = np.array([[focal_length, 0, center[0]],
                                  [0, focal_length, center[1]],
                                  [0, 0, 1]], dtype="double")

        success, rotation_vector, translation_vector = cv2.solvePnP(
            model_points, image_points, camera_matrix, np.zeros((4, 1))
        )
        rotation_matrix, _ = cv2.Rodrigues(rotation_vector)
        pose_mat = cv2.hconcat((rotation_matrix, translation_vector))
        _, _, _, _, _, _, euler_angles = cv2.decomposeProjectionMatrix(pose_mat)
        yaw = euler_angles[1, 0]
        return yaw
    except:
        return 0

def detect_phone(frame):
    if not yolo_available:
        return False, []

    h, w, _ = frame.shape
    blob = cv2.dnn.blobFromImage(frame, 1/255.0, (416, 416), swapRB=True, crop=False)
    net.setInput(blob)
    outs = net.forward(output_layers)

    boxes, confs = [], []
    for out in outs:
        for det in out:
            scores = det[5:]
            class_id = np.argmax(scores)
            conf = scores[class_id]
            if class_id == 67 and conf > 0.35:
                cx, cy, ww, hh = int(det[0]*w), int(det[1]*h), int(det[2]*w), int(det[3]*h)
                x, y = int(cx - ww/2), int(cy - hh/2)
                boxes.append([x, y, ww, hh])
                confs.append(float(conf))

    phones = []
    if boxes:
        idxs = cv2.dnn.NMSBoxes(boxes, confs, 0.3, 0.45)
        for i in idxs.flatten():
            phones.append((boxes[i], confs[i]))
    return len(phones) > 0, phones

# === Webcam ===
cap = cv2.VideoCapture(0)
cap.set(3, 640)
cap.set(4, 480)
if not cap.isOpened():
    print("❌ Camera not available")
    exit()

# === Vars ===
YAW_THRESHOLD = 40
yaw_history = deque(maxlen=5)
alert_cooldown = 5
last_alert = 0
frame_count = 0

print("SmartStudyBuddy++ Running...")

while True:
    ret, frame = cap.read()
    if not ret:
        break
    frame_count += 1

    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    mesh_results = face_mesh.process(rgb)
    face_results = face_detector.process(rgb)

    face_detected = False
    yaw = 0
    looking_at_screen = True

    if mesh_results.multi_face_landmarks:
        face_detected = True
        landmarks = mesh_results.multi_face_landmarks[0].landmark
        yaw = get_head_pose(landmarks, frame.shape[1], frame.shape[0])
        yaw_history.append(yaw)
        smooth_yaw = np.mean(yaw_history)
        looking_at_screen = abs(smooth_yaw) < YAW_THRESHOLD
    elif face_results.detections:
        face_detected = True  # fallback for side faces
        looking_at_screen = False  # side profile likely not facing camera

    phone_detected, phone_boxes = (False, [])
    if frame_count % 15 == 0:
        phone_detected, phone_boxes = detect_phone(frame)

    status = "FOCUSED"
    color = (0, 255, 0)

    # === Priority Logic ===
    if phone_detected:
        status = "PHONE DETECTED"
        color = (255, 0, 255)
        if time.time() - last_alert > alert_cooldown:
            play_sound(sound_go_back)
            last_alert = time.time()
    elif face_detected and not looking_at_screen:
        status = "LOOKING AWAY"
        color = (0, 165, 255)
        if time.time() - last_alert > alert_cooldown:
            play_sound(sound_go_back)
            last_alert = time.time()
    elif not face_detected:
        status = "NO FACE DETECTED"
        color = (0, 0, 255)
        if time.time() - last_alert > alert_cooldown:
            play_sound(sound_alert)
            last_alert = time.time()

    # === Draws ===
    cv2.putText(frame, status, (30, 40), cv2.FONT_HERSHEY_SIMPLEX, 1, color, 3)
    if phone_detected:
        for (box, conf) in phone_boxes:
            x, y, w, h = box
            cv2.rectangle(frame, (x, y), (x + w, y + h), (255, 0, 255), 2)
            cv2.putText(frame, f"Phone {conf:.2f}", (x, y - 5),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 0, 255), 2)

    cv2.imshow("SmartStudyBuddy++", frame)
    if cv2.waitKey(1) & 0xFF == ord('q'):
        break

cap.release()
cv2.destroyAllWindows()
pygame.mixer.quit()
