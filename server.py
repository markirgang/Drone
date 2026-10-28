#!/usr/bin/env python3
"""
Pixhawk 4 Drone Web Server & Multimodal MAVLink Control Hub
Runs on Raspberry Pi. Connects to Pixhawk 4 over GPIO UART (/dev/ttyAMA0) or USB.
Provides real-time 3D telemetry dashboard, eMeet Pixy camera stream, hands-free Gemini live chat & voice control.
"""

import http.server
import socketserver
import json
import os
import sys
import socket
import ssl
import cv2
import base64
import threading
import time
import random
import urllib.parse
import re
import local_audio
import numpy as np

from mavlink_drone import PixhawkDroneController
from gemini_bridge import GeminiDroneBridge

PORT = int(os.environ.get("PORT", 1190))
HOST = os.environ.get("HOST", os.environ.get("IP", "127.0.0.1"))
DIRECTORY = os.environ.get("DIRECTORY", os.path.join(os.path.dirname(os.path.abspath(__file__)), "static"))

def generate_synthetic_camera_frame():
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    frame[:, :] = (20, 25, 35)
    cv2.putText(frame, "EMEET PIXY DRONE CAMERA FEED", (110, 200), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 240, 255), 2)
    cv2.putText(frame, "STATUS: Virtual Camera Stream Active", (130, 240), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (160, 255, 160), 1)
    t_str = time.strftime("%H:%M:%S")
    cv2.putText(frame, f"LIVE TIME: {t_str}", (220, 280), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1)
    return frame

class CameraStream:
    def __init__(self, source="usb"):
        self.source = str(source).lower()
        self.cap = None
        self.picam2 = None
        self.frame = None
        self.lock = threading.Lock()
        self.running = True
        self.thread = threading.Thread(target=self._update, daemon=True)
        self.thread.start()

    def set_source(self, source):
        with self.lock:
            self.source = str(source).lower()
            self._close_cameras()

    def _close_cameras(self):
        if self.cap:
            try:
                self.cap.release()
            except Exception:
                pass
            self.cap = None
        if self.picam2:
            try:
                self.picam2.stop()
                self.picam2.close()
            except Exception:
                pass
            self.picam2 = None

    def _update(self):
        while self.running:
            with self.lock:
                cur_source = self.source

            if cur_source in ["csi", "picamera", "raspberry_pi", "ov5647"]:
                if self.picam2 is None:
                    self._close_cameras()
                    try:
                        from picamera2 import Picamera2
                        p = Picamera2()
                        config = p.create_preview_configuration(main={'size': (640, 480)})
                        p.configure(config)
                        p.start()
                        time.sleep(0.3)
                        self.picam2 = p
                        print("Picamera2 CSI Camera initialized successfully")
                    except Exception as e:
                        print("Picamera2 CSI Camera init error:", e)
                        self.picam2 = None
                        time.sleep(1.0)
                        continue

                try:
                    frame_array = self.picam2.capture_array('main')
                    if frame_array is not None and frame_array.size > 0:
                        if frame_array.shape[2] == 4:
                            frame_bgr = cv2.cvtColor(frame_array, cv2.COLOR_RGBA2BGR)
                        else:
                            frame_bgr = frame_array
                        with self.lock:
                            self.frame = frame_bgr
                    time.sleep(0.04)
                except Exception as e:
                    print("CSI frame capture error:", e)
                    self._close_cameras()
                    time.sleep(0.5)

            else:
                if self.cap is None or not self.cap.isOpened():
                    self._close_cameras()
                    candidates = [0, 1, 2, 6, 8, 23]
                    if cur_source.isdigit():
                        candidates.insert(0, int(cur_source))
                    candidates = list(dict.fromkeys(candidates))

                    opened = False
                    for idx in candidates:
                        try:
                            cap = cv2.VideoCapture(idx, cv2.CAP_V4L2)
                            if cap.isOpened():
                                ret, frame = cap.read()
                                if ret and frame is not None and frame.size > 0:
                                    self.cap = cap
                                    with self.lock:
                                        self.frame = frame
                                    opened = True
                                    print(f"eMeet Pixy / USB Webcam initialized on /dev/video{idx}")
                                    break
                                else:
                                    cap.release()
                        except Exception:
                            pass

                    if not opened:
                        time.sleep(4.0)

                if self.cap and self.cap.isOpened():
                    try:
                        ret, frame = self.cap.read()
                        if ret and frame is not None and frame.size > 0:
                            with self.lock:
                                self.frame = frame
                            time.sleep(0.04)
                        else:
                            self._close_cameras()
                            time.sleep(1.0)
                    except Exception:
                        self._close_cameras()
                        time.sleep(1.0)
                else:
                    time.sleep(0.5)

    def get_frame(self):
        with self.lock:
            if self.frame is not None:
                return self.frame.copy()
        return generate_synthetic_camera_frame()

camera_stream = CameraStream("usb")
drone = PixhawkDroneController(port="/dev/ttyAMA0", baudrate=921600)
gemini_bridge = GeminiDroneBridge()

class DroneRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def do_HEAD(self):
        if self.path.startswith("/api/"):
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
        else:
            super().do_HEAD()

    def do_GET(self):
        if self.path.startswith("/api/status"):
            self.send_json({
                "status": "online",
                "device": "Raspberry Pi - Drone Hub",
                "python_version": sys.version,
                "mavlink_connected": drone.is_connected,
                "simulation_mode": drone.simulation_mode
            })
        elif self.path.startswith("/api/telemetry"):
            self.send_json(drone.get_telemetry())
        elif self.path.startswith("/api/camera/frame"):
            self.serve_camera_frame()
        elif self.path.startswith("/api/tts/speak"):
            query_params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            text_to_speak = query_params.get("text", ["Hello! Pixhawk Drone operational."])[0]
            voice_id = query_params.get("voice", ["ai_female_us"])[0]

            try:
                from gtts import gTTS
                import io
                clean_text = re.sub(r'\*[^*]*\*', '', text_to_speak).strip()
                if not clean_text:
                    clean_text = "Pixhawk Drone system ready."

                tld_map = {
                    "ai_female_us": ("en", "com"),
                    "ai_male_us": ("en", "us"),
                    "ai_male_uk": ("en", "co.uk"),
                    "ai_male_au": ("en", "com.au"),
                    "ai_male_ie": ("en", "ie"),
                    "ai_female_uk": ("en", "co.uk")
                }

                lang, tld = tld_map.get(voice_id, ("en", "com"))
                tts = gTTS(text=clean_text, lang=lang, tld=tld)
                mp3_fp = io.BytesIO()
                tts.write_to_fp(mp3_fp)
                mp3_fp.seek(0)
                audio_bytes = mp3_fp.read()

                self.send_response(200)
                self.send_header('Content-type', 'audio/mpeg')
                self.send_header('Cache-Control', 'no-cache')
                self.end_headers()
                self.wfile.write(audio_bytes)
            except Exception as e:
                self.send_json({"error": str(e)}, status=500)
        elif self.path.startswith("/api/audio/outputs") or self.path.startswith("/api/audio/sinks"):
            self.send_json({"outputs": local_audio.list_local_audio_outputs()})
        else:
            super().do_GET()

    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length).decode('utf-8') if content_length > 0 else "{}"
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            data = {}

        if self.path in ["/api/audio/play", "/api/audio/play_local"]:
            audio_bytes, content_type = local_audio.load_audio_bytes_from_url(data.get("url", ""))
            if not audio_bytes:
                self.send_json({"error": "Unable to load audio for local playback"}, status=500)
            else:
                local_audio.play_audio_on_local_output(audio_bytes, content_type, data.get("speaker", "default"), data.get("volume", 100))
                self.send_json({"success": True, "speaker": data.get("speaker", "default")})
            return

        if self.path == "/api/drone/arm":
            success = drone.arm()
            self.send_json({"success": success, "armed": True})

        elif self.path == "/api/drone/disarm":
            force = data.get("force", False)
            success = drone.disarm(force=force)
            self.send_json({"success": success, "armed": False})

        elif self.path == "/api/drone/takeoff":
            alt = float(data.get("altitude", 2.5))
            success = drone.takeoff(altitude=alt)
            self.send_json({"success": success, "altitude": alt})

        elif self.path == "/api/drone/land":
            success = drone.land()
            self.send_json({"success": success})

        elif self.path == "/api/drone/rtl":
            success = drone.return_to_launch()
            self.send_json({"success": success})

        elif self.path == "/api/drone/mode":
            mode = data.get("mode", "POSCTL")
            success = drone.set_flight_mode(mode)
            self.send_json({"success": success, "mode": mode})

        elif self.path == "/api/drone/manual":
            pitch = float(data.get("pitch", 0.0))
            roll = float(data.get("roll", 0.0))
            yaw = float(data.get("yaw", 0.0))
            alt_rate = float(data.get("altitude_rate", 0.0))
            drone.set_manual_vector(pitch, roll, yaw, alt_rate)
            self.send_json({"success": True})

        elif self.path == "/api/camera/select":
            source = data.get("source", "usb")
            camera_stream.set_source(source)
            self.send_json({"success": True, "active_source": source})

        elif self.path == "/api/gemini/chat":
            user_text = data.get("prompt", "")
            DEFAULT_GEMINI_KEY = base64.b64decode("QVEuQWI4Uk42SU9GSDQ4UXNyWWNLLWEzUnp0OFc5RVZiZG0yTHJWRmlnQlE1Y0RySTBjaHc=").decode("utf-8")
            api_key = data.get("api_key") or os.environ.get("GEMINI_API_KEY") or DEFAULT_GEMINI_KEY
            include_vision = data.get("include_vision", True)

            image_bytes = self.capture_camera_bytes() if include_vision else None
            result = gemini_bridge.generate_chat_response(api_key, user_text, image_bytes)
            
            # Execute MAVLink Tool Call if requested by Gemini AI
            if result.get("action"):
                self.dispatch_drone_action(result["action"])

            self.send_json(result)

        elif self.path == "/api/gemini/voice":
            DEFAULT_GEMINI_KEY = base64.b64decode("QVEuQWI4Uk42SU9GSDQ4UXNyWWNLLWEzUnp0OFc5RVZiZG0yTHJWRmlnQlE1Y0RySTBjaHc=").decode("utf-8")
            api_key = data.get("api_key") or os.environ.get("GEMINI_API_KEY") or DEFAULT_GEMINI_KEY
            audio_b64 = data.get("audio_b64", "")
            mime_type = data.get("mime_type", "audio/webm")
            include_vision = data.get("include_vision", True)

            audio_bytes = base64.b64decode(audio_b64) if audio_b64 else None
            image_bytes = self.capture_camera_bytes() if include_vision else None

            result = gemini_bridge.generate_voice_chat_response(api_key, audio_bytes, mime_type, image_bytes)

            if result.get("action"):
                self.dispatch_drone_action(result["action"])

            self.send_json(result)

        elif self.path == "/api/gemini/gesture":
            frame = self.capture_camera_frame()
            if frame is None:
                self.send_json({"gesture": "None", "finger_count": 0, "action": None})
            else:
                gesture, finger_count, _ = gemini_bridge.detect_hand_gestures(frame)
                action = None
                if gesture == "5_FINGERS_TAKEOFF":
                    action = {"name": "drone_takeoff", "args": {"altitude_meters": 2.5}}
                elif gesture == "2_FINGERS_YAW":
                    action = {"name": "drone_fly_direction", "args": {"direction": "turn_right"}}
                elif gesture == "1_FINGER_LAND":
                    action = {"name": "drone_land", "args": {}}

                if action:
                    self.dispatch_drone_action(action)

                self.send_json({
                    "gesture": gesture,
                    "finger_count": finger_count,
                    "action": action
                })

        elif self.path == "/api/export-python":
            python_script = self.generate_standalone_script()
            self.send_response(200)
            self.send_header('Content-type', 'application/x-python')
            self.send_header('Content-Disposition', 'attachment; filename="pixhawk4_raspberrypi_control.py"')
            self.end_headers()
            self.wfile.write(python_script.encode('utf-8'))

        else:
            self.send_json({"error": "Endpoint not found"}, status=404)

    def dispatch_drone_action(self, action):
        """Executes MAVLink drone tools called by Gemini AI or gesture system."""
        name = action.get("name")
        args = action.get("args", {})

        if name == "drone_arm":
            drone.arm()
        elif name == "drone_disarm":
            drone.disarm()
        elif name == "drone_takeoff":
            alt = float(args.get("altitude_meters", 2.5))
            drone.takeoff(alt)
        elif name == "drone_land":
            drone.land()
        elif name == "drone_rtl":
            drone.return_to_launch()
        elif name == "drone_set_mode":
            mode = args.get("mode", "POSCTL")
            drone.set_flight_mode(mode)
        elif name == "drone_fly_direction":
            d = args.get("direction", "forward")
            if d == "forward":
                drone.set_manual_vector(1.0, 0.0, 0.0, 0.0)
            elif d == "backward":
                drone.set_manual_vector(-1.0, 0.0, 0.0, 0.0)
            elif d == "left":
                drone.set_manual_vector(0.0, -1.0, 0.0, 0.0)
            elif d == "right":
                drone.set_manual_vector(0.0, 1.0, 0.0, 0.0)
            elif d == "ascend":
                drone.set_manual_vector(0.0, 0.0, 0.0, 1.0)
            elif d == "descend":
                drone.set_manual_vector(0.0, 0.0, 0.0, -1.0)
            elif d == "turn_left":
                drone.set_manual_vector(0.0, 0.0, -1.0, 0.0)
            elif d == "turn_right":
                drone.set_manual_vector(0.0, 0.0, 1.0, 0.0)
            elif d == "stop":
                drone.set_manual_vector(0.0, 0.0, 0.0, 0.0)

    def capture_camera_frame(self):
        return camera_stream.get_frame()

    def capture_camera_bytes(self):
        frame = self.capture_camera_frame()
        if frame is None:
            frame = generate_synthetic_camera_frame()
        ret, jpeg = cv2.imencode('.jpg', frame)
        return jpeg.tobytes() if ret else None

    def serve_camera_frame(self):
        jpeg_bytes = self.capture_camera_bytes()
        if jpeg_bytes is None:
            try:
                self.send_response(503)
                self.end_headers()
            except Exception:
                pass
            return
        try:
            self.send_response(200)
            self.send_header('Content-type', 'image/jpeg')
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.end_headers()
            self.wfile.write(jpeg_bytes)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def send_json(self, data, status=200):
        try:
            self.send_response(status)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(data).encode('utf-8'))
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def generate_standalone_script(self):
        return '''#!/usr/bin/env python3
"""
Standalone Pixhawk 4 MAVLink Drone Controller for Raspberry Pi
Connects to Pixhawk TELEM1 / TELEM2 over GPIO UART (/dev/ttyAMA0 @ 921600 baud).
"""

import time
from pymavlink import mavutil

# Connection Parameters
SERIAL_PORT = "/dev/ttyAMA0" # GPIO UART on Raspberry Pi
BAUD_RATE = 921600          # Default baud rate for Pixhawk 4 TELEM port

def main():
    print(f"Connecting to Pixhawk 4 on {SERIAL_PORT} @ {BAUD_RATE} baud...")
    master = mavutil.mavlink_connection(SERIAL_PORT, baud=BAUD_RATE)

    print("Waiting for heartbeat...")
    master.wait_heartbeat()
    print(f"Connected! System ID: {master.target_system}, Component ID: {master.target_component}")

    # Arm drone
    print("Arming motors...")
    master.mav.command_long_send(
        master.target_system,
        master.target_component,
        mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM,
        0, 1, 0, 0, 0, 0, 0, 0
    )
    time.sleep(2)

    # Autonomous Takeoff to 3 meters
    print("Taking off to 3 meters...")
    master.mav.command_long_send(
        master.target_system,
        master.target_component,
        mavutil.mavlink.MAV_CMD_NAV_TAKEOFF,
        0, 0, 0, 0, 0, 0, 0, 3.0
    )
    time.sleep(8)

    # Autonomous Landing
    print("Landing drone...")
    master.mav.command_long_send(
        master.target_system,
        master.target_component,
        mavutil.mavlink.MAV_CMD_NAV_LAND,
        0, 0, 0, 0, 0, 0, 0, 0
    )
    print("Mission Complete!")

if __name__ == "__main__":
    main()
'''

class ThreadingReusableTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True
    ssl_context = None

    def get_request(self):
        newsocket, fromaddr = self.socket.accept()
        if self.ssl_context:
            try:
                first_byte = newsocket.recv(1, socket.MSG_PEEK)
                if first_byte and first_byte[0] == 0x16:
                    newsocket = self.ssl_context.wrap_socket(newsocket, server_side=True)
            except Exception:
                pass
        return newsocket, fromaddr

if __name__ == "__main__":
    for i in range(1, len(sys.argv)):
        if sys.argv[i] == "--port" and i + 1 < len(sys.argv):
            PORT = int(sys.argv[i + 1])
        elif sys.argv[i] == "--host" and i + 1 < len(sys.argv):
            HOST = sys.argv[i + 1]

    cert_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cert.pem")
    key_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "key.pem")
    if not (os.path.exists(cert_path) and os.path.exists(key_path)):
        cert_path = "/home/markirgang/Tweedpump/cert.pem"
        key_path = "/home/markirgang/Tweedpump/key.pem"

    ssl_ctx = None
    if os.path.exists(cert_path) and os.path.exists(key_path):
        try:
            ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ssl_ctx.load_cert_chain(certfile=cert_path, keyfile=key_path)
        except Exception as e:
            print(f"SSL cert load warning: {e}")

    display_host = "localhost" if HOST in ["", "0.0.0.0", "127.0.0.1"] else HOST
    print(f"Starting Pixhawk 4 Drone Hub Server on http://{display_host}:{PORT} (http & https supported)")
    bind_host = "" if HOST == "0.0.0.0" else HOST
    with ThreadingReusableTCPServer((bind_host, PORT), DroneRequestHandler) as httpd:
        httpd.ssl_context = ssl_ctx
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")
