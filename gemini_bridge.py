#!/usr/bin/env python3
"""
Gemini AI Multimodal Bridge for Pixhawk 4 Drone
Processes eMeet Pixy camera vision, microphone audio, hand gestures, and executes MAVLink drone flight controls via tool calling.
"""

import cv2
import numpy as np
import base64
import json
import os
from google import genai
from google.genai import types

class GeminiDroneBridge:
    def __init__(self):
        self.system_instruction = (
            "You are the intelligent, safety-conscious AI pilot brain of a Pixhawk 4 prop drone equipped with an eMeet Pixy camera and microphone. "
            "Your job is to:\n"
            "1. Produce warm, professional, concise conversational responses (1-3 sentences) informing the operator about flight status, camera sight, or actions taken.\n"
            "2. Describe what you see clearly when presented with camera snapshots.\n"
            "3. Execute drone flight commands safely using tool function calls whenever the user asks the drone to arm, disarm, takeoff, land, return home (RTL), hover, change flight mode, or fly in a direction.\n"
            "Always prioritize flight safety and inform the user before major maneuvers."
        )

    def detect_hand_gestures(self, frame):
        """
        Analyzes eMeet Pixy camera frame for hand gestures (5 fingers open = Takeoff, 2 fingers = Turn/Yaw, 1 finger = Land).
        Returns: (gesture_name, finger_count, annotated_frame)
        """
        try:
            resized = cv2.resize(frame, (320, 240))
            blur = cv2.GaussianBlur(resized, (5, 5), 0)
            hsv = cv2.cvtColor(blur, cv2.COLOR_BGR2HSV)

            # Skin color range in HSV
            lower_skin = np.array([0, 20, 70], dtype=np.uint8)
            upper_skin = np.array([20, 255, 255], dtype=np.uint8)
            mask = cv2.inRange(hsv, lower_skin, upper_skin)

            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
            mask = cv2.erode(mask, kernel, iterations=1)
            mask = cv2.dilate(mask, kernel, iterations=2)

            contours, _ = cv2.findContours(mask, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
            if not contours:
                return "None", 0, frame

            max_contour = max(contours, key=cv2.contourArea)
            area = cv2.contourArea(max_contour)

            if area < 2800:
                return "None", 0, frame

            hull = cv2.convexHull(max_contour, returnPoints=False)
            if hull is None or len(hull) < 3:
                return "None", 0, frame

            defects = cv2.convexityDefects(max_contour, hull)
            finger_count = 0

            if defects is not None:
                for i in range(defects.shape[0]):
                    s, e, f, d = defects[i, 0]
                    start = tuple(max_contour[s][0])
                    end = tuple(max_contour[e][0])
                    far = tuple(max_contour[f][0])

                    a = np.sqrt((end[0] - start[0])**2 + (end[1] - start[1])**2)
                    b = np.sqrt((far[0] - start[0])**2 + (far[1] - start[1])**2)
                    c = np.sqrt((end[0] - far[0])**2 + (end[1] - far[1])**2)

                    angle = np.arccos((b**2 + c**2 - a**2) / (2 * b * c + 1e-5))

                    if angle <= np.pi / 2 and d > 1200:
                        finger_count += 1

                finger_count += 1

            gesture = "None"
            if finger_count >= 4:
                gesture = "5_FINGERS_TAKEOFF"
            elif finger_count == 2 or finger_count == 3:
                gesture = "2_FINGERS_YAW"
            elif finger_count == 1:
                gesture = "1_FINGER_LAND"

            return gesture, finger_count, frame
        except Exception:
            return "None", 0, frame

    def generate_chat_response(self, api_key, user_text="", image_bytes=None):
        """
        Sends text prompt and camera frame snapshot to Google Gemini AI API.
        Returns: { text: str, action: dict }
        """
        if not api_key:
            return {
                "text": "Please provide a valid Google Gemini API Key in the settings tab to enable AI flight assistant features.",
                "action": None
            }

        client = genai.Client(api_key=api_key)

        # Declare Pixhawk Drone Tools
        tools = [
            types.Tool(function_declarations=[
                types.FunctionDeclaration(
                    name="drone_arm",
                    description="Arms the drone motors so it is ready for flight.",
                    parameters=types.Schema(type=types.Type.OBJECT, properties={})
                ),
                types.FunctionDeclaration(
                    name="drone_disarm",
                    description="Disarms the drone motors to safely stop prop rotation.",
                    parameters=types.Schema(type=types.Type.OBJECT, properties={})
                ),
                types.FunctionDeclaration(
                    name="drone_takeoff",
                    description="Takes off autonomously to a target altitude in meters.",
                    parameters=types.Schema(
                        type=types.Type.OBJECT,
                        properties={
                            "altitude_meters": types.Schema(type=types.Type.NUMBER, description="Altitude in meters (e.g., 2.5)")
                        }
                    )
                ),
                types.FunctionDeclaration(
                    name="drone_land",
                    description="Lands the drone autonomously at its current position.",
                    parameters=types.Schema(type=types.Type.OBJECT, properties={})
                ),
                types.FunctionDeclaration(
                    name="drone_rtl",
                    description="Returns the drone to its home takeoff location (Return to Launch).",
                    parameters=types.Schema(type=types.Type.OBJECT, properties={})
                ),
                types.FunctionDeclaration(
                    name="drone_fly_direction",
                    description="Flies or nudges the drone in a direction.",
                    parameters=types.Schema(
                        type=types.Type.OBJECT,
                        properties={
                            "direction": types.Schema(
                                type=types.Type.STRING,
                                enum=["forward", "backward", "left", "right", "ascend", "descend", "turn_left", "turn_right", "stop"]
                            ),
                            "distance_meters": types.Schema(type=types.Type.NUMBER)
                        },
                        required=["direction"]
                    )
                ),
                types.FunctionDeclaration(
                    name="drone_set_mode",
                    description="Sets the Pixhawk flight mode (e.g. OFFBOARD, POSCTL, ALTCTL, HOLD, RTL, LAND).",
                    parameters=types.Schema(
                        type=types.Type.OBJECT,
                        properties={
                            "mode": types.Schema(
                                type=types.Type.STRING,
                                enum=["OFFBOARD", "POSCTL", "ALTCTL", "HOLD", "AUTO.RTL", "AUTO.LAND", "AUTO.TAKEOFF"]
                            )
                        },
                        required=["mode"]
                    )
                )
            ])
        ]

        contents = []

        if image_bytes:
            contents.append(types.Part.from_bytes(
                data=image_bytes,
                mime_type="image/jpeg"
            ))

        prompt_text = user_text if user_text else "Describe what you see through your camera feed and report drone readiness!"
        contents.append(prompt_text)

        config = types.GenerateContentConfig(
            system_instruction=self.system_instruction,
            tools=tools,
            temperature=0.7
        )

        try:
            response = client.models.generate_content(
                model="gemini-3.8-flash",
                contents=contents,
                config=config
            )

            action = None
            text_response = response.text or ""

            if response.function_calls:
                call = response.function_calls[0]
                action = {
                    "name": call.name,
                    "args": call.args
                }
                if not text_response:
                    text_response = f"Executing flight command: {call.name}"

            return {
                "text": text_response,
                "action": action
            }

        except Exception as e:
            return {
                "text": f"Gemini AI API Error: {str(e)}",
                "action": None
            }

    def generate_voice_chat_response(self, api_key, audio_bytes, mime_type="audio/webm", image_bytes=None):
        """
        Processes spoken mic audio from eMeet Pixy webcam mic using Gemini Voice Engine.
        """
        if not api_key:
            return {"text": "Please provide a valid Google Gemini API Key.", "action": None}

        client = genai.Client(api_key=api_key)

        tools = [
            types.Tool(function_declarations=[
                types.FunctionDeclaration(
                    name="drone_arm",
                    description="Arms the drone motors.",
                    parameters=types.Schema(type=types.Type.OBJECT, properties={})
                ),
                types.FunctionDeclaration(
                    name="drone_disarm",
                    description="Disarms the drone motors.",
                    parameters=types.Schema(type=types.Type.OBJECT, properties={})
                ),
                types.FunctionDeclaration(
                    name="drone_takeoff",
                    description="Takes off autonomously to target altitude.",
                    parameters=types.Schema(
                        type=types.Type.OBJECT,
                        properties={
                            "altitude_meters": types.Schema(type=types.Type.NUMBER)
                        }
                    )
                ),
                types.FunctionDeclaration(
                    name="drone_land",
                    description="Lands the drone autonomously.",
                    parameters=types.Schema(type=types.Type.OBJECT, properties={})
                ),
                types.FunctionDeclaration(
                    name="drone_rtl",
                    description="Returns the drone to launch base.",
                    parameters=types.Schema(type=types.Type.OBJECT, properties={})
                ),
                types.FunctionDeclaration(
                    name="drone_fly_direction",
                    description="Flies the drone in a direction.",
                    parameters=types.Schema(
                        type=types.Type.OBJECT,
                        properties={
                            "direction": types.Schema(
                                type=types.Type.STRING,
                                enum=["forward", "backward", "left", "right", "ascend", "descend", "turn_left", "turn_right", "stop"]
                            )
                        },
                        required=["direction"]
                    )
                ),
                types.FunctionDeclaration(
                    name="drone_set_mode",
                    description="Sets flight mode.",
                    parameters=types.Schema(
                        type=types.Type.OBJECT,
                        properties={
                            "mode": types.Schema(type=types.Type.STRING)
                        },
                        required=["mode"]
                    )
                )
            ])
        ]

        contents = []

        if audio_bytes:
            contents.append(types.Part.from_bytes(
                data=audio_bytes,
                mime_type=mime_type
            ))

        if image_bytes:
            contents.append(types.Part.from_bytes(
                data=image_bytes,
                mime_type="image/jpeg"
            ))

        contents.append(
            "Listen to my spoken voice input in the audio file above.\n"
            "1. Transcribe the exact words I spoke.\n"
            "2. Respond to me concisely in 1-2 professional, friendly sentences.\n"
            "3. If I asked the drone to arm, disarm, takeoff, land, return home, turn, or fly in a direction, call the matching tool function.\n\n"
            "Format your text response as:\n"
            "TRANSCRIPTION: [exact spoken words]\n"
            "RESPONSE: [your conversational answer]"
        )

        config = types.GenerateContentConfig(
            system_instruction=self.system_instruction,
            tools=tools,
            temperature=0.7
        )

        try:
            response = client.models.generate_content(
                model="gemini-3.8-flash",
                contents=contents,
                config=config
            )

            action = None
            raw_text = response.text or ""
            user_transcription = ""
            text_response = raw_text

            if "TRANSCRIPTION:" in raw_text:
                parts = raw_text.split("RESPONSE:", 1)
                user_transcription = parts[0].replace("TRANSCRIPTION:", "").strip()
                if len(parts) > 1:
                    text_response = parts[1].strip()

            if response.function_calls:
                call = response.function_calls[0]
                action = {"name": call.name, "args": call.args}
                if not text_response:
                    text_response = f"Executing flight command: {call.name}"

            return {
                "transcription": user_transcription,
                "text": text_response,
                "action": action
            }

        except Exception as e:
            return {"text": f"Gemini Voice Processing Error: {str(e)}", "action": None}
