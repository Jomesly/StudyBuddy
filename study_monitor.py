import cv2
import pygame
import mediapipe as mp
import time
import pygetwindow as gw
import numpy as np
from collections import deque
from ultralytics import YOLO

# Initialize MediaPipe
mp_face = mp.solutions.face_detection.FaceDetection(min_detection_confidence=0.5)
mp_face_mesh = mp.solutions.face_mesh.FaceMesh(
    min_detection_confidence=0.5,
    min_tracking_confidence=0.5
)
mp_hands = mp.solutions.hands.Hands(
    min_detection_confidence=0.6,
    min_tracking_confidence=0.5,
    max_num_hands=2
)

# Initialize YOLO for phone detection
print("Loading YOLOv8 model...")
try:
    yolo_model = YOLO('yolov8n.pt')
    print("✓ YOLOv8 loaded successfully")
except Exception as e:
    print(f"⚠ Could not load YOLOv8: {e}")
    print("Install with: pip install ultralytics")
    exit()

# Initialize pygame mixer
pygame.mixer.init()

# Load sounds
try:
    sound_go_back = pygame.mixer.Sound("go_back.mp3")
except:
    sound_go_back = None
    print("⚠ go_back.mp3 not found")

try:
    sound_alert = pygame.mixer.Sound("alert.mp3")
except:
    sound_alert = None
    print("⚠ alert.mp3 not found")

# UI State
is_paused = False
show_analytics = False

# Stability buffer
class StabilityBuffer:
    def __init__(self, size=10):
        self.buffer = deque(maxlen=size)
        self.size = size
    
    def add(self, value):
        self.buffer.append(value)
    
    def get_stable_state(self):
        if len(self.buffer) < self.size // 2:
            return None
        if not self.buffer:
            return None
        return max(set(self.buffer), key=list(self.buffer).count)
    
    def clear(self):
        self.buffer.clear()

head_pose_buffer = StabilityBuffer(size=15)
phone_detection_buffer = deque(maxlen=10)
talking_detection_buffer = deque(maxlen=30)

def play_go_back():
    if sound_go_back and not is_paused:
        try:
            sound_go_back.stop()  # Stop any currently playing sound
            sound_go_back.play()
            print("🔊 Playing go_back alert")
        except Exception as e:
            print(f"Error playing go_back sound: {e}")

def play_alert():
    if sound_alert and not is_paused:
        try:
            sound_alert.stop()  # Stop any currently playing sound
            sound_alert.play()
            print("🔔 Playing alert sound")
        except Exception as e:
            print(f"Error playing alert sound: {e}")

def get_active_window_title():
    try:
        active_window = gw.getActiveWindow()
        if active_window:
            return active_window.title
        return "Unknown"
    except:
        return "Unknown"

def is_study_app(window_title):
    study_keywords = [
        "visual studio code", "vscode", "pycharm", "jupyter",
        "word", "excel", "powerpoint", "google docs", "notion",
        "adobe", "pdf", "reader", "notepad", "sublime",
        "atom", "eclipse", "intellij", "study", "learn",
        "canvas", "moodle", "classroom", "zoom", "teams",
        "github", "stackoverflow", "python", "programming",
        "smartstudybuddy", "focus"
    ]
    
    distraction_keywords = [
        "youtube", "facebook", "instagram", "twitter", "tiktok",
        "netflix", "spotify", "steam", "epic games", "discord",
        "valorant", "league", "minecraft", "roblox", "game",
        "twitch", "reddit", "pinterest", "snapchat", "whatsapp",
        "messenger", "fortnite", "apex", "gta", "cod", "pubg",
        "dota", "csgo", "overwatch", "among us", "fall guys"
    ]
    
    window_lower = window_title.lower()
    
    for keyword in distraction_keywords:
        if keyword in window_lower:
            return False, f"{keyword.title()}"
    
    for keyword in study_keywords:
        if keyword in window_lower:
            return True, f"{keyword.title()}"
    
    browsers = ["chrome", "edge", "firefox", "safari", "brave"]
    for browser in browsers:
        if browser in window_lower:
            return True, "Browser"
    
    return True, "Other App"

def check_head_pose(face_landmarks, frame_width, frame_height):
    if not face_landmarks:
        return True, "forward", 0.0
    
    landmarks = face_landmarks.landmark
    
    nose = landmarks[1]
    left_eye = landmarks[33]
    right_eye = landmarks[263]
    left_eye_inner = landmarks[133]
    right_eye_inner = landmarks[362]
    
    nose_x = nose.x
    left_eye_x = left_eye.x
    right_eye_x = right_eye.x
    face_width = abs(right_eye_x - left_eye_x)
    face_center = (left_eye_x + right_eye_x) / 2
    nose_offset = nose_x - face_center
    normalized_offset = nose_offset / (face_width + 0.001)
    
    if normalized_offset > 0.15:
        return False, "right", 0.0
    elif normalized_offset < -0.15:
        return False, "left", 0.0
    
    nose_y = nose.y
    eyes_y = (left_eye_inner.y + right_eye_inner.y) / 2
    down_angle = nose_y - eyes_y
    
    if down_angle > 0.25:
        return False, "down", down_angle
    
    return True, "forward", down_angle

def detect_mouth_open(face_landmarks):
    if not face_landmarks:
        return False, 0.0
    
    landmarks = face_landmarks.landmark
    upper_lip = landmarks[13]
    lower_lip = landmarks[14]
    left_corner = landmarks[61]
    right_corner = landmarks[291]
    
    mouth_height = abs(lower_lip.y - upper_lip.y)
    mouth_width = abs(right_corner.x - left_corner.x)
    
    if mouth_width > 0:
        mouth_ratio = mouth_height / mouth_width
    else:
        mouth_ratio = 0.0
    
    is_open = mouth_ratio > 0.25
    return is_open, mouth_ratio

def detect_phone_with_yolo(frame):
    results = yolo_model(frame, verbose=False)
    
    phone_boxes = []
    max_confidence = 0.0
    
    for result in results:
        boxes = result.boxes
        for box in boxes:
            class_id = int(box.cls[0])
            class_name = yolo_model.names[class_id]
            confidence = float(box.conf[0])
            
            if class_name == 'cell phone' and confidence > 0.4:
                x1, y1, x2, y2 = box.xyxy[0].cpu().numpy()
                phone_boxes.append({
                    'bbox': (int(x1), int(y1), int(x2), int(y2)),
                    'confidence': confidence
                })
                max_confidence = max(max_confidence, confidence)
    
    phone_detected = len(phone_boxes) > 0
    return phone_detected, max_confidence, phone_boxes

def check_phone_near_hands(phone_boxes, hand_results, frame_shape):
    if not phone_boxes or not hand_results or not hand_results.multi_hand_landmarks:
        return False, 0.0
    
    h, w = frame_shape[:2]
    
    hand_positions = []
    for hand_landmarks in hand_results.multi_hand_landmarks:
        wrist = hand_landmarks.landmark[0]
        hand_x = int(wrist.x * w)
        hand_y = int(wrist.y * h)
        hand_positions.append((hand_x, hand_y))
    
    min_distance = float('inf')
    closest_phone_conf = 0.0
    
    for phone in phone_boxes:
        x1, y1, x2, y2 = phone['bbox']
        phone_center_x = (x1 + x2) // 2
        phone_center_y = (y1 + y2) // 2
        
        for hand_x, hand_y in hand_positions:
            distance = np.sqrt((phone_center_x - hand_x)**2 + (phone_center_y - hand_y)**2)
            
            if distance < min_distance:
                min_distance = distance
                closest_phone_conf = phone['confidence']
    
    is_near_hand = min_distance < 400
    return is_near_hand, closest_phone_conf

def draw_rounded_rect(img, pt1, pt2, color, thickness, radius=15):
    """Draw a rounded rectangle"""
    x1, y1 = pt1
    x2, y2 = pt2
    
    # Draw main rectangle
    cv2.rectangle(img, (x1 + radius, y1), (x2 - radius, y2), color, -1)
    cv2.rectangle(img, (x1, y1 + radius), (x2, y2 - radius), color, -1)
    
    # Draw corners
    cv2.circle(img, (x1 + radius, y1 + radius), radius, color, -1)
    cv2.circle(img, (x2 - radius, y1 + radius), radius, color, -1)
    cv2.circle(img, (x1 + radius, y2 - radius), radius, color, -1)
    cv2.circle(img, (x2 - radius, y2 - radius), radius, color, -1)

def draw_button(img, x, y, w, h, text, color, is_active=False):
    """Draw a modern button with hover effect"""
    button_color = color if not is_active else tuple([int(c * 1.2) if c * 1.2 <= 255 else 255 for c in color])
    
    # Shadow
    shadow_offset = 2
    draw_rounded_rect(img, (x + shadow_offset, y + shadow_offset), 
                     (x + w + shadow_offset, y + h + shadow_offset), 
                     (50, 50, 50), -1, 8)
    
    # Button
    draw_rounded_rect(img, (x, y), (x + w, y + h), button_color, -1, 8)
    
    # Border
    cv2.rectangle(img, (x, y), (x + w, y + h), (255, 255, 255), 1)
    
    # Text - adaptive scaling
    img_h, img_w = img.shape[:2]
    font_scale = min(0.65, img_w / 1000)
    thickness = 2
    text_size = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, font_scale, thickness)[0]
    text_x = x + (w - text_size[0]) // 2
    text_y = y + (h + text_size[1]) // 2
    cv2.putText(img, text, (text_x, text_y), cv2.FONT_HERSHEY_SIMPLEX, 
                font_scale, (255, 255, 255), thickness)
    
    return (x, y, w, h)

def draw_analytics_panel(img, stats):
    """Draw analytics overlay"""
    h, w = img.shape[:2]
    
    # Semi-transparent overlay
    overlay = img.copy()
    panel_margin = int(w * 0.15)
    panel_width = w - 2 * panel_margin
    panel_height = int(h * 0.65)
    panel_x = panel_margin
    panel_y = (h - panel_height) // 2
    
    cv2.rectangle(overlay, (panel_x, panel_y), 
                 (panel_x + panel_width, panel_y + panel_height), 
                 (30, 30, 30), -1)
    cv2.addWeighted(overlay, 0.9, img, 0.1, 0, img)
    
    # Border
    cv2.rectangle(img, (panel_x, panel_y), 
                 (panel_x + panel_width, panel_y + panel_height), 
                 (100, 200, 255), 3)
    
    # Title
    title_y = panel_y + 40
    title_text = "SESSION ANALYTICS"
    title_scale = min(0.9, panel_width / 500)
    cv2.putText(img, title_text, 
                (panel_x + 40, title_y), 
                cv2.FONT_HERSHEY_SIMPLEX, title_scale, (100, 200, 255), 2)
    
    # Stats
    stats_y = title_y + 50
    line_height = int(panel_height / 14)
    
    total_time = stats['total_time']
    
    analytics_data = [
        ("Total Session Time", f"{int(total_time)}s", (255, 255, 255)),
        ("True Focused Time", f"{int(stats['focused_time'])}s", (0, 255, 0)),
        ("Focus Percentage", f"{stats['focus_percentage']:.1f}%", (0, 255, 0)),
        ("", "", (255, 255, 255)),  # Spacer
        ("Distractions Breakdown:", "", (200, 200, 200)),
        ("  Phone Usage", f"{int(stats['phone_time'])}s", (255, 100, 100)),
        ("  Talking", f"{int(stats['talking_time'])}s", (255, 165, 0)),
        ("  Looking Away", f"{int(stats['looking_away_time'])}s", (255, 200, 0)),
        ("  Distraction Apps", f"{int(stats['app_time'])}s", (255, 150, 100)),
        ("  Away from Desk", f"{int(stats['away_time'])}s", (200, 100, 100)),
    ]
    
    text_scale = min(0.55, panel_width / 700)
    
    for i, (label, value, color) in enumerate(analytics_data):
        y_pos = stats_y + i * line_height
        cv2.putText(img, label, (panel_x + 40, y_pos), 
                   cv2.FONT_HERSHEY_SIMPLEX, text_scale, color, 1)
        if value:
            value_x = panel_x + panel_width - 120
            cv2.putText(img, value, (value_x, y_pos), 
                       cv2.FONT_HERSHEY_SIMPLEX, text_scale, color, 1)
    
    # Close instruction
    close_y = panel_y + panel_height - 25
    cv2.putText(img, "Press 'A' to close analytics", 
                (panel_x + 40, close_y), 
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (150, 150, 150), 1)

def bubble_sort_distractions(distraction_list):
    n = len(distraction_list)
    for i in range(n):
        for j in range(0, n - i - 1):
            if distraction_list[j][1] < distraction_list[j + 1][1]:
                distraction_list[j], distraction_list[j + 1] = distraction_list[j + 1], distraction_list[j]
    return distraction_list

def mouse_callback(event, x, y, flags, param):
    """Handle mouse clicks on buttons"""
    global is_paused, show_analytics
    
    if event == cv2.EVENT_LBUTTONDOWN:
        buttons = param
        
        # Check pause button
        pause_btn = buttons['pause']
        if (pause_btn[0] <= x <= pause_btn[0] + pause_btn[2] and 
            pause_btn[1] <= y <= pause_btn[1] + pause_btn[3]):
            is_paused = not is_paused
        
        # Check analytics button
        analytics_btn = buttons['analytics']
        if (analytics_btn[0] <= x <= analytics_btn[0] + analytics_btn[2] and 
            analytics_btn[1] <= y <= analytics_btn[1] + analytics_btn[3]):
            show_analytics = not show_analytics

# Open webcam
cap = cv2.VideoCapture(0)
if not cap.isOpened():
    print("ERROR: Cannot open webcam")
    exit()

# Set camera resolution for better view
cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)

# Warm up the camera with a few initial reads
print("Warming up camera...")
camera_ready = False
for i in range(5):
    ret, frame = cap.read()
    if ret:
        print(f"✓ Camera warmup frame {i+1} OK")
        camera_ready = True
        break
    else:
        print(f"WARNING: Camera warmup frame {i+1} failed, trying again...")
        time.sleep(0.2)

if not camera_ready:
    print("\n" + "="*60)
    print("❌ CAMERA ERROR - Cannot capture video frames!")
    print("="*60)
    print("\nPossible solutions:")
    print("1. Check if camera is connected and enabled")
    print("2. Close other apps using the camera (Discord, Zoom, Teams, etc.)")
    print("3. Try restarting the program")
    print("4. Check camera driver/permissions in Windows Settings")
    print("5. Try a different camera device (modify: cv2.VideoCapture(1) instead of 0)")
    print("\nOn Windows, check Settings > Privacy & Security > Camera")
    print("="*60)
    cap.release()
    exit()

print("=" * 60)
print("Study Buddy - Enhanced UI Version")
print("=" * 60)
print("Controls:")
print("  SPACE - Pause/Resume")
print("  A - Toggle Analytics")
print("  Q - Quit")
print("=" * 60)

# Tracking variables
session_start = time.time()
face_detected_time = 0
truly_focused_time = 0
face_absent_time = 0
distracted_by_app_time = 0
distracted_by_phone_time = 0
distracted_by_talking_time = 0
looking_away_time = 0
last_check = time.time()
last_seen_face = time.time()
last_alert_time = 0
last_window_check = time.time()
alert_cooldown = 5
was_away = False
was_on_distraction = False
was_on_phone = False
was_looking_away = False
was_talking = False
current_app = "Unknown"
is_study = True
frame_count = 0
state_start_time = time.time()
current_stable_state = "forward"
minimum_state_duration = 1.5

# Pause tracking
pause_start_time = 0
total_pause_time = 0

# Create window and set mouse callback
window_name = "Study Buddy"
cv2.namedWindow(window_name, cv2.WINDOW_NORMAL)
buttons = {'pause': (0, 0, 0, 0), 'analytics': (0, 0, 0, 0)}
cv2.setMouseCallback(window_name, mouse_callback, buttons)

while True:
    ret, frame = cap.read()
    if not ret:
        break

    frame_count += 1
    current_time = time.time()
    
    # Get adaptive dimensions
    h, w = frame.shape[:2]
    
    # Handle pause state
    if is_paused:
        if pause_start_time == 0:
            pause_start_time = current_time
    else:
        if pause_start_time > 0:
            total_pause_time += (current_time - pause_start_time)
            pause_start_time = 0
    
    elapsed = current_time - last_check
    last_check = current_time

    if not is_paused:
        # Process frame (existing detection logic)
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        face_results = mp_face.process(rgb)
        mesh_results = mp_face_mesh.process(rgb)
        hand_results = mp_hands.process(rgb)
        
        face_present = bool(face_results.detections)
        time_away = current_time - last_seen_face

        raw_looking_forward = True
        raw_look_direction = "forward"
        down_angle = 0.0
        mouth_open = False
        mouth_ratio = 0.0
        
        if mesh_results.multi_face_landmarks:
            raw_looking_forward, raw_look_direction, down_angle = check_head_pose(
                mesh_results.multi_face_landmarks[0], w, h
            )
            mouth_open, mouth_ratio = detect_mouth_open(mesh_results.multi_face_landmarks[0])
            head_pose_buffer.add(raw_look_direction)
            talking_detection_buffer.append(mouth_open)
        else:
            head_pose_buffer.add("forward")
            talking_detection_buffer.append(False)
        
        stable_direction = head_pose_buffer.get_stable_state()
        if stable_direction is None:
            stable_direction = "forward"
        
        is_looking_forward = (stable_direction == "forward")
        look_direction = stable_direction
        
        if stable_direction != current_stable_state:
            current_stable_state = stable_direction
            state_start_time = current_time
        
        time_in_current_state = current_time - state_start_time

        phone_detected_raw, phone_confidence, phone_boxes = detect_phone_with_yolo(frame)
        phone_near_hands, phone_usage_conf = check_phone_near_hands(phone_boxes, hand_results, frame.shape)
        phone_in_use = phone_detected_raw
        phone_detection_buffer.append(phone_in_use)
        phone_stable = sum(phone_detection_buffer) >= 4
        
        talking_frames = sum(talking_detection_buffer)
        is_talking = talking_frames >= 15

        if current_time - last_window_check > 2:
            window_title = get_active_window_title()
            is_study, app_info = is_study_app(window_title)
            current_app = app_info
            last_window_check = current_time

        # PRIORITY SYSTEM (existing logic)
        if not face_present and time_away > 2:
            face_absent_time += elapsed
            status = "AWAY FROM DESK"
            color = (0, 0, 255)
            warning_type = "away"
            
            if not was_away:
                was_away = True
            
            if current_time - last_alert_time > alert_cooldown:
                play_go_back()
                last_alert_time = current_time
                
        elif phone_stable and face_present:
            distracted_by_phone_time += elapsed
            face_detected_time += elapsed
            last_seen_face = current_time
            status = "PHONE DETECTED!"
            color = (0, 0, 255)
            warning_type = "phone"
            
            if was_away:
                play_alert()
                was_away = False
            
            if not was_on_phone:
                was_on_phone = True
                play_go_back()
                last_alert_time = current_time
            elif current_time - last_alert_time > alert_cooldown:
                play_go_back()
                last_alert_time = current_time
            
            was_on_distraction = False
            was_looking_away = False
            was_talking = False
            
        elif face_present and is_talking and (not is_looking_forward or look_direction in ["left", "right"]):
            distracted_by_talking_time += elapsed
            face_detected_time += elapsed
            last_seen_face = current_time
            status = "TALKING TO SOMEONE"
            color = (0, 165, 255)
            warning_type = "talking"
            
            if was_away:
                play_alert()
                was_away = False
            
            was_on_phone = False
            
            if not was_talking:
                was_talking = True
                play_go_back()
                last_alert_time = current_time
            elif current_time - last_alert_time > alert_cooldown:
                play_go_back()
                last_alert_time = current_time
            
        elif face_present and not is_looking_forward and time_in_current_state > minimum_state_duration:
            looking_away_time += elapsed
            face_detected_time += elapsed
            last_seen_face = current_time
            status = f"LOOKING {look_direction.upper()}"
            color = (0, 165, 255)
            warning_type = "looking_away"
            
            if was_away:
                play_alert()
                was_away = False
            
            was_on_phone = False
            was_talking = False
            
            if not was_looking_away:
                was_looking_away = True
                play_go_back()
                last_alert_time = current_time
            elif current_time - last_alert_time > alert_cooldown:
                play_go_back()
                last_alert_time = current_time
                
        elif face_present and not is_study:
            distracted_by_app_time += elapsed
            face_detected_time += elapsed
            last_seen_face = current_time
            status = "DISTRACTED"
            color = (0, 165, 255)
            warning_type = "distraction_app"
            
            if was_away:
                play_alert()
                was_away = False
            
            was_on_phone = False
            was_looking_away = False
            was_talking = False
            
            if not was_on_distraction:
                was_on_distraction = True
                play_go_back()
                last_alert_time = current_time
            elif current_time - last_alert_time > alert_cooldown:
                play_go_back()
                last_alert_time = current_time
                
        elif face_present and is_study and is_looking_forward:
            face_detected_time += elapsed
            truly_focused_time += elapsed
            last_seen_face = current_time
            status = "FOCUSED ✓"
            color = (0, 255, 0)
            warning_type = None
            
            # Play alert when returning to focus from any distraction
            if was_away or was_on_distraction or was_on_phone or was_looking_away or was_talking:
                play_alert()
                print("✅ User is focused again!")
                
            was_away = False
            was_on_distraction = False
            was_on_phone = False
            was_looking_away = False
            was_talking = False
            
        else:
            status = "CHECKING..."
            color = (255, 255, 0)
            warning_type = None

        # Draw visualizations
        if face_present:
            for det in face_results.detections:
                bbox = det.location_data.relative_bounding_box
                x1 = int(bbox.xmin * w)
                y1 = int(bbox.ymin * h)
                x2 = x1 + int(bbox.width * w)
                y2 = y1 + int(bbox.height * h)
                
                cv2.rectangle(frame, (x1, y1), (x2, y2), color, 3)

        for phone in phone_boxes:
            x1, y1, x2, y2 = phone['bbox']
            conf = phone['confidence']
            cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 0, 255), 3)
            label = f"PHONE {conf:.2f}"
            cv2.putText(frame, label, (x1, y1 - 10),
                       cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)

        if hand_results.multi_hand_landmarks:
            for hand_landmarks in hand_results.multi_hand_landmarks:
                for connection in mp.solutions.hands.HAND_CONNECTIONS:
                    start_idx = connection[0]
                    end_idx = connection[1]
                    start = hand_landmarks.landmark[start_idx]
                    end = hand_landmarks.landmark[end_idx]
                    
                    start_point = (int(start.x * w), int(start.y * h))
                    end_point = (int(end.x * w), int(end.y * h))
                    
                    cv2.line(frame, start_point, end_point, (255, 255, 0), 2)
                
                for landmark in hand_landmarks.landmark:
                    cx, cy = int(landmark.x * w), int(landmark.y * h)
                    cv2.circle(frame, (cx, cy), 5, (255, 255, 0), -1)

        # Draw warning banner
        banner_height = int(h * 0.16)
        info_y = banner_height + 35
        
        if warning_type == "away":
            cv2.rectangle(frame, (0, 0), (w, banner_height), (0, 0, 255), -1)
            text_scale = min(2.2, w / 320)
            cv2.putText(frame, "COME BACK!", (int(w * 0.05), int(banner_height * 0.48)),
                       cv2.FONT_HERSHEY_SIMPLEX, text_scale, (255, 255, 255), 4)
            cv2.putText(frame, f"Away for {int(time_away)}s", (int(w * 0.05), int(banner_height * 0.78)),
                       cv2.FONT_HERSHEY_SIMPLEX, text_scale * 0.4, (255, 255, 255), 2)
            
        elif warning_type == "phone":
            cv2.rectangle(frame, (0, 0), (w, banner_height), (0, 0, 255), -1)
            text_scale = min(1.9, w / 380)
            cv2.putText(frame, "PUT DOWN YOUR PHONE!", (int(w * 0.03), int(banner_height * 0.48)),
                       cv2.FONT_HERSHEY_SIMPLEX, text_scale, (255, 255, 255), 4)
            cv2.putText(frame, f"Detected: {phone_usage_conf:.2f} confidence", (int(w * 0.03), int(banner_height * 0.78)),
                       cv2.FONT_HERSHEY_SIMPLEX, text_scale * 0.4, (255, 255, 255), 2)
            
        elif warning_type == "talking":
            cv2.rectangle(frame, (0, 0), (w, banner_height), (0, 165, 255), -1)
            text_scale = min(1.9, w / 370)
            cv2.putText(frame, "STOP TALKING!", (int(w * 0.04), int(banner_height * 0.48)),
                       cv2.FONT_HERSHEY_SIMPLEX, text_scale, (255, 255, 255), 4)
            cv2.putText(frame, f"Talking detected: {mouth_ratio:.2f}", (int(w * 0.04), int(banner_height * 0.78)),
                       cv2.FONT_HERSHEY_SIMPLEX, text_scale * 0.4, (255, 255, 255), 2)
            
        elif warning_type == "looking_away":
            cv2.rectangle(frame, (0, 0), (w, banner_height), (0, 165, 255), -1)
            text_scale = min(1.9, w / 370)
            cv2.putText(frame, f"LOOK AT SCREEN!", (int(w * 0.04), int(banner_height * 0.48)),
                       cv2.FONT_HERSHEY_SIMPLEX, text_scale, (255, 255, 255), 4)
            cv2.putText(frame, f"Looking {look_direction}", (int(w * 0.04), int(banner_height * 0.78)),
                       cv2.FONT_HERSHEY_SIMPLEX, text_scale * 0.4, (255, 255, 255), 2)
            
        elif warning_type == "distraction_app":
            cv2.rectangle(frame, (0, 0), (w, banner_height), (0, 165, 255), -1)
            text_scale = min(1.7, w / 410)
            cv2.putText(frame, "CLOSE DISTRACTION!", (int(w * 0.04), int(banner_height * 0.48)),
                       cv2.FONT_HERSHEY_SIMPLEX, text_scale, (255, 255, 255), 4)
            cv2.putText(frame, f"Detected: {current_app}", (int(w * 0.04), int(banner_height * 0.78)),
                       cv2.FONT_HERSHEY_SIMPLEX, text_scale * 0.4, (255, 255, 255), 2)
        else:
            # No warning banner, start info higher
            info_y = int(h * 0.12)

        # Calculate stats
        total_time = current_time - session_start - total_pause_time
        focus_percentage = (truly_focused_time / total_time * 100) if total_time > 0 else 0

        # Stats with better spacing - positioned below banner or at top
        stat_scale = min(0.7, w / 850)
        cv2.putText(frame, f"Status: {status}", (20, info_y),
                    cv2.FONT_HERSHEY_SIMPLEX, stat_scale, color, 2)
        cv2.putText(frame, f"Focus: {focus_percentage:.1f}%", (20, info_y + 35),
                    cv2.FONT_HERSHEY_SIMPLEX, stat_scale * 0.85, (255, 255, 255), 2)
        cv2.putText(frame, f"Session: {int(total_time)}s", (20, info_y + 65),
                    cv2.FONT_HERSHEY_SIMPLEX, stat_scale * 0.85, (255, 255, 255), 2)
        
        num_phones = len(phone_boxes)
        # White color (B=255, G=255, R=255)
        text_color = (255, 255, 255)
        # Set thickness to 2 or 3 for a bold appearance
        text_thickness = 2 
        cv2.putText(frame, f"Phones: {num_phones} | Hands: {phone_near_hands} | Talk: {talking_frames}/30", 
            (20, info_y + 95), cv2.FONT_HERSHEY_SIMPLEX, stat_scale * 0.7, text_color, text_thickness)
        
        # App info at bottom
        app_text = f"App: {current_app[:35]}"
        cv2.putText(frame, app_text, (20, h - 25),
                    cv2.FONT_HERSHEY_SIMPLEX, stat_scale * 0.7, (180, 180, 180), 1)
    
    else:
        # Paused state - show existing frame with overlay
        total_time = current_time - session_start - total_pause_time
        focus_percentage = (truly_focused_time / total_time * 100) if total_time > 0 else 0
        
        overlay = frame.copy()
        cv2.rectangle(overlay, (0, 0), (w, h), (50, 50, 50), -1)
        cv2.addWeighted(overlay, 0.5, frame, 0.5, 0, frame)
        
        pause_scale = min(2.0, w / 300)
        cv2.putText(frame, "PAUSED", (int(w * 0.30), int(h * 0.45)),
                   cv2.FONT_HERSHEY_SIMPLEX, pause_scale, (255, 200, 0), 3)
        
        instruction_scale = min(0.7, w / 800)
        cv2.putText(frame, "Press SPACE or click button to resume", 
                   (int(w * 0.15), int(h * 0.55)),
                   cv2.FONT_HERSHEY_SIMPLEX, instruction_scale, (255, 255, 255), 2)

    # Draw modern header with app name
    header_height = int(h * 0.09)
    cv2.rectangle(frame, (0, 0), (w, header_height), (40, 40, 40), -1)
    cv2.rectangle(frame, (0, header_height - 2), (w, header_height), (100, 200, 255), -1)
    
    # App title with icon - scaled
    title_scale = min(1.0, w / 600)
    cv2.putText(frame, "STUDY BUDDY", (int(w * 0.02), int(header_height * 0.65)),
               cv2.FONT_HERSHEY_SIMPLEX, title_scale, (100, 200, 255), 3)
    
    # Session info in header - scaled
    total_time = current_time - session_start - total_pause_time
    focus_percentage = (truly_focused_time / total_time * 100) if total_time > 0 else 0
    
    session_text = f"Focus: {focus_percentage:.0f}% | Time: {int(total_time//60)}m {int(total_time%60)}s"
    session_scale = min(0.65, w / 850)
    cv2.putText(frame, session_text, (int(w * 0.38), int(header_height * 0.65)),
               cv2.FONT_HERSHEY_SIMPLEX, session_scale, (255, 255, 255), 2)

    # Draw control buttons (bottom right) - scaled
    button_width = int(w * 0.12)
    button_height = int(h * 0.055)
    button_margin = int(w * 0.015)
    button_y = h - button_height - button_margin - 8
    
    # Pause/Resume button
    pause_x = w - button_margin - button_width
    pause_text = "RESUME" if is_paused else "PAUSE"
    pause_color = (100, 200, 100) if is_paused else (255, 150, 0)
    buttons['pause'] = draw_button(frame, pause_x, button_y, button_width, button_height, 
                                   pause_text, pause_color)
    
    # Analytics button
    analytics_x = pause_x - button_width - int(button_margin * 0.5)
    analytics_color = (100, 150, 255) if show_analytics else (80, 120, 200)
    buttons['analytics'] = draw_button(frame, analytics_x, button_y, button_width, button_height, 
                                       "STATS", analytics_color, show_analytics)
    
    # Show analytics overlay if enabled
    if show_analytics:
        stats = {
            'total_time': total_time,
            'focused_time': truly_focused_time,
            'focus_percentage': focus_percentage,
            'phone_time': distracted_by_phone_time,
            'talking_time': distracted_by_talking_time,
            'looking_away_time': looking_away_time,
            'app_time': distracted_by_app_time,
            'away_time': face_absent_time
        }
        draw_analytics_panel(frame, stats)

    cv2.imshow(window_name, frame)

    # Keyboard controls
    key = cv2.waitKey(1) & 0xFF
    if key == ord("q"):
        break
    elif key == ord(" "):  # Space bar
        is_paused = not is_paused
    elif key == ord("a"):  # A key
        show_analytics = not show_analytics

# Cleanup
cap.release()
cv2.destroyAllWindows()
pygame.mixer.quit()

# Final stats
total_time = time.time() - session_start - total_pause_time
focus_percentage = (truly_focused_time / total_time * 100) if total_time > 0 else 0
print("\n" + "=" * 60)
print("SESSION SUMMARY")
print("=" * 60)
print(f"Total session time: {int(total_time)} seconds ({int(total_time//60)}m {int(total_time%60)}s)")
print(f"TRUE FOCUSED TIME: {int(truly_focused_time)} seconds ({int(truly_focused_time//60)}m {int(truly_focused_time%60)}s)")
print(f"\nTrue focus percentage: {focus_percentage:.1f}%")
print(f"Total pause time: {int(total_pause_time)} seconds")

distrations_summary = [
    ("Phone Usage",      distracted_by_phone_time),
    ("Talking",          distracted_by_talking_time),
    ("Looking Away",     looking_away_time),
    ("Distraction Apps", distracted_by_app_time),
    ("Away from Desk",   face_absent_time),
]
distrations_summary = bubble_sort_distractions(distrations_summary)

print(f"\nDistractions Ranked (Most to Least):")
for i, (label, value) in enumerate(distrations_summary):
    print(f"  #{i+1} {label}: {int(value)} seconds")
print("=" * 60)