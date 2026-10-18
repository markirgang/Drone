#!/usr/bin/env python3
"""
MAVLink Drone Controller Module for Pixhawk 4
Supports PX4 and ArduPilot firmware over GPIO UART (/dev/ttyAMA0, /dev/serial0, /dev/ttyS0) or USB (/dev/ttyACM0).
Includes realistic hardware simulation mode when physical Pixhawk is disconnected.
"""

import time
import math
import threading
import random

try:
    from pymavlink import mavutil
    PYMAVLINK_AVAILABLE = True
except ImportError:
    PYMAVLINK_AVAILABLE = False


class PixhawkDroneController:
    def __init__(self, port="/dev/ttyAMA0", baudrate=921600):
        self.port = port
        self.baudrate = baudrate
        self.master = None
        self.is_connected = False
        self.simulation_mode = True
        
        # Telemetry State
        self.telemetry = {
            "armed": False,
            "mode": "POSCTL", # Default PX4 mode
            "firmware": "PX4 Autopilot",
            "roll": 0.0,       # degrees
            "pitch": 0.0,      # degrees
            "yaw": 0.0,        # degrees
            "heading": 0.0,    # degrees
            "altitude": 0.0,   # meters relative to home
            "climb_rate": 0.0, # m/s
            "groundspeed": 0.0,# m/s
            "airspeed": 0.0,   # m/s
            "battery_voltage": 16.8, # Volts (4S LiPo)
            "battery_current": 1.2,  # Amps
            "battery_percentage": 98,# %
            "gps_fix_type": 3, # 3 = 3D Fix
            "satellites": 14,
            "latitude": 37.774929,
            "longitude": -122.419416,
            "is_connected": False,
            "is_simulation": True,
            "last_heartbeat": 0.0,
            "status_message": "Ready (Simulation Active)"
        }

        # Simulated state physics targets
        self._sim_target_alt = 0.0
        self._sim_target_roll = 0.0
        self._sim_target_pitch = 0.0
        self._sim_target_yaw = 0.0
        self._sim_vx = 0.0
        self._sim_vy = 0.0

        self.lock = threading.Lock()
        self.running = True

        # Attempt MAVLink connection
        self._connect_mavlink()

        # Start telemetry loop thread
        self.telemetry_thread = threading.Thread(target=self._telemetry_loop, daemon=True)
        self.telemetry_thread.start()

    def _connect_mavlink(self):
        """Attempts connection to Pixhawk over serial UART/USB."""
        if not PYMAVLINK_AVAILABLE:
            print("[MAVLink] pymavlink not installed. Running in SIMULATION mode.")
            self.simulation_mode = True
            return

        candidate_ports = [self.port, "/dev/ttyAMA0", "/dev/serial0", "/dev/ttyS0", "/dev/ttyUSB0", "/dev/ttyACM0"]
        candidate_ports = list(dict.fromkeys(candidate_ports))

        for p in candidate_ports:
            try:
                print(f"[MAVLink] Attempting connection on {p} @ {self.baudrate} baud...")
                master = mavutil.mavlink_connection(p, baud=self.baudrate, autoreconnect=True, timeout=1.5)
                # Wait for heartbeat
                hb = master.wait_heartbeat(timeout=1.5)
                if hb is not None:
                    print(f"[MAVLink] SUCCESS! Pixhawk connected on {p}. System ID: {master.target_system}")
                    self.master = master
                    self.port = p
                    self.is_connected = True
                    self.simulation_mode = False
                    with self.lock:
                        self.telemetry["is_connected"] = True
                        self.telemetry["is_simulation"] = False
                        self.telemetry["status_message"] = f"Connected via {p}"
                    return
            except Exception as e:
                print(f"[MAVLink] Connection on {p} failed: {e}")

        print("[MAVLink] No physical Pixhawk detected. Defaulting to REALISTIC SIMULATION mode.")
        self.simulation_mode = True
        with self.lock:
            self.telemetry["is_connected"] = False
            self.telemetry["is_simulation"] = True
            self.telemetry["status_message"] = "Simulation Active (Pixhawk Disconnected)"

    def _telemetry_loop(self):
        """Continuous background telemetry reader / simulation physics thread."""
        last_sim_time = time.time()

        while self.running:
            now = time.time()
            dt = now - last_sim_time
            last_sim_time = now

            if not self.simulation_mode and self.master:
                # Read real MAVLink messages
                try:
                    msg = self.master.recv_match(blocking=False)
                    while msg:
                        msg_type = msg.get_type()

                        if msg_type == "HEARTBEAT":
                            with self.lock:
                                self.telemetry["armed"] = bool(msg.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED)
                                self.telemetry["last_heartbeat"] = now
                                self.telemetry["is_connected"] = True

                        elif msg_type == "ATTITUDE":
                            with self.lock:
                                self.telemetry["roll"] = math.degrees(msg.roll)
                                self.telemetry["pitch"] = math.degrees(msg.pitch)
                                self.telemetry["yaw"] = (math.degrees(msg.yaw) + 360) % 360
                                self.telemetry["heading"] = self.telemetry["yaw"]

                        elif msg_type == "VFR_HUD":
                            with self.lock:
                                self.telemetry["altitude"] = round(msg.alt, 2)
                                self.telemetry["climb_rate"] = round(msg.climb, 2)
                                self.telemetry["groundspeed"] = round(msg.groundspeed, 2)
                                self.telemetry["airspeed"] = round(msg.airspeed, 2)

                        elif msg_type == "SYS_STATUS":
                            with self.lock:
                                self.telemetry["battery_voltage"] = round(msg.voltage_battery / 1000.0, 2)
                                self.telemetry["battery_current"] = round(msg.current_battery / 100.0, 2)
                                self.telemetry["battery_percentage"] = msg.battery_remaining if msg.battery_remaining >= 0 else 95

                        elif msg_type == "GPS_RAW_INT":
                            with self.lock:
                                self.telemetry["gps_fix_type"] = msg.fix_type
                                self.telemetry["satellites"] = msg.satellites_visible
                                self.telemetry["latitude"] = msg.lat / 1e7
                                self.telemetry["longitude"] = msg.lon / 1e7

                        msg = self.master.recv_match(blocking=False)

                    # Check heartbeat timeout
                    if now - self.telemetry["last_heartbeat"] > 4.0:
                        with self.lock:
                            self.telemetry["is_connected"] = False
                            self.telemetry["status_message"] = "Connection Lost - Reconnecting..."
                        self._connect_mavlink()

                except Exception as e:
                    print(f"[MAVLink] Error in recv_match: {e}")
                    time.sleep(0.1)

            else:
                # Physics & Telemetry Simulation
                with self.lock:
                    is_armed = self.telemetry["armed"]
                    cur_alt = self.telemetry["altitude"]

                    # Smooth transition to target altitude if armed
                    if is_armed:
                        target_alt = self._sim_target_alt
                    else:
                        target_alt = 0.0

                    alt_diff = target_alt - cur_alt
                    climb_rate = max(-3.0, min(3.0, alt_diff * 2.0))
                    cur_alt += climb_rate * dt
                    if cur_alt < 0.05:
                        cur_alt = 0.0
                        climb_rate = 0.0

                    self.telemetry["altitude"] = round(cur_alt, 2)
                    self.telemetry["climb_rate"] = round(climb_rate, 2)

                    # Attitude physics simulation (smooth easing + noise)
                    noise_r = (random.random() - 0.5) * 0.8 if cur_alt > 0 else 0.0
                    noise_p = (random.random() - 0.5) * 0.8 if cur_alt > 0 else 0.0
                    
                    self.telemetry["roll"] += (self._sim_target_roll - self.telemetry["roll"]) * 0.15 + noise_r
                    self.telemetry["pitch"] += (self._sim_target_pitch - self.telemetry["pitch"]) * 0.15 + noise_p
                    self.telemetry["yaw"] = (self.telemetry["yaw"] + self._sim_target_yaw * dt * 30.0) % 360
                    self.telemetry["heading"] = round(self.telemetry["yaw"], 1)

                    # Speed simulation based on tilt
                    speed = math.sqrt(self.telemetry["roll"]**2 + self.telemetry["pitch"]**2) * 0.15 if cur_alt > 0 else 0.0
                    self.telemetry["groundspeed"] = round(speed, 1)
                    self.telemetry["airspeed"] = round(speed * 1.05, 1)

                    # Battery discharge simulation
                    if is_armed:
                        current = 12.5 + (cur_alt * 0.5) + (speed * 0.3)
                        self.telemetry["battery_percentage"] = max(5.0, self.telemetry["battery_percentage"] - (dt * 0.01))
                    else:
                        current = 0.8

                    self.telemetry["battery_current"] = round(current, 1)
                    self.telemetry["battery_voltage"] = round(14.0 + (self.telemetry["battery_percentage"] / 100.0) * 2.8, 2)

                    # Simulated GPS drift / movement
                    if cur_alt > 0:
                        rad = math.radians(self.telemetry["heading"])
                        self.telemetry["latitude"] += math.cos(rad) * speed * dt * 0.00001
                        self.telemetry["longitude"] += math.sin(rad) * speed * dt * 0.00001

            time.sleep(0.05)

    def arm(self):
        """Arms the drone motors."""
        with self.lock:
            self.telemetry["armed"] = True
            self.telemetry["status_message"] = "ARMED - Motors Spinning"

        if not self.simulation_mode and self.master:
            try:
                self.master.mav.command_long_send(
                    self.master.target_system,
                    self.master.target_component,
                    mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM,
                    0, 1, 0, 0, 0, 0, 0, 0
                )
            except Exception as e:
                print(f"[MAVLink] Arm command error: {e}")
        return True

    def disarm(self, force=False):
        """Disarms the drone motors."""
        with self.lock:
            self.telemetry["armed"] = False
            self._sim_target_alt = 0.0
            self.telemetry["status_message"] = "DISARMED - Safety Active"

        if not self.simulation_mode and self.master:
            try:
                param2 = 21196.0 if force else 0.0
                self.master.mav.command_long_send(
                    self.master.target_system,
                    self.master.target_component,
                    mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM,
                    0, 0, param2, 0, 0, 0, 0, 0
                )
            except Exception as e:
                print(f"[MAVLink] Disarm command error: {e}")
        return True

    def takeoff(self, altitude=2.5):
        """Triggers autonomous takeoff to target altitude in meters."""
        self.arm()
        with self.lock:
            self._sim_target_alt = altitude
            self.telemetry["mode"] = "AUTO.TAKEOFF"
            self.telemetry["status_message"] = f"Taking off to {altitude}m altitude..."

        if not self.simulation_mode and self.master:
            try:
                self.master.mav.command_long_send(
                    self.master.target_system,
                    self.master.target_component,
                    mavutil.mavlink.MAV_CMD_NAV_TAKEOFF,
                    0, 0, 0, 0, 0, 0, 0, altitude
                )
            except Exception as e:
                print(f"[MAVLink] Takeoff error: {e}")
        return True

    def land(self):
        """Triggers autonomous landing sequence."""
        with self.lock:
            self._sim_target_alt = 0.0
            self.telemetry["mode"] = "AUTO.LAND"
            self.telemetry["status_message"] = "Initiating Autonomous Landing..."

        if not self.simulation_mode and self.master:
            try:
                self.master.mav.command_long_send(
                    self.master.target_system,
                    self.master.target_component,
                    mavutil.mavlink.MAV_CMD_NAV_LAND,
                    0, 0, 0, 0, 0, 0, 0, 0
                )
            except Exception as e:
                print(f"[MAVLink] Land error: {e}")
        return True

    def return_to_launch(self):
        """Triggers Return to Launch (RTL)."""
        with self.lock:
            self.telemetry["mode"] = "AUTO.RTL"
            self.telemetry["status_message"] = "Returning to Launch Base (RTL)..."

        if not self.simulation_mode and self.master:
            try:
                self.master.mav.command_long_send(
                    self.master.target_system,
                    self.master.target_component,
                    mavutil.mavlink.MAV_CMD_NAV_RETURN_TO_LAUNCH,
                    0, 0, 0, 0, 0, 0, 0, 0
                )
            except Exception as e:
                print(f"[MAVLink] RTL error: {e}")
        return True

    def set_flight_mode(self, mode_name):
        """Sets flight mode (e.g. OFFBOARD, POSCTL, ALTCTL, AUTO.RTL, AUTO.LAND, HOLD)."""
        mode_str = str(mode_name).upper()
        with self.lock:
            self.telemetry["mode"] = mode_str
            self.telemetry["status_message"] = f"Flight Mode set to: {mode_str}"

        if not self.simulation_mode and self.master:
            try:
                mode_id = self.master.mode_mapping().get(mode_str)
                if mode_id is not None:
                    self.master.set_mode(mode_id)
            except Exception as e:
                print(f"[MAVLink] Mode set error: {e}")
        return True

    def set_manual_vector(self, pitch_norm, roll_norm, yaw_rate_norm, altitude_change_norm):
        """
        Receives manual control inputs (-1.0 to +1.0) for pitch, roll, yaw, and altitude.
        """
        with self.lock:
            if not self.telemetry["armed"]:
                return

            self._sim_target_pitch = pitch_norm * 20.0  # max 20 deg pitch tilt
            self._sim_target_roll = roll_norm * 20.0    # max 20 deg roll tilt
            self._sim_target_yaw = yaw_rate_norm        # yaw rotation speed

            if altitude_change_norm != 0:
                self._sim_target_alt = max(0.5, min(100.0, self._sim_target_alt + (altitude_change_norm * 0.2)))

        if not self.simulation_mode and self.master:
            try:
                # Send MAVLink MANUAL_CONTROL or SET_POSITION_TARGET_LOCAL_NED
                self.master.mav.manual_control_send(
                    self.master.target_system,
                    int(pitch_norm * 1000),
                    int(roll_norm * 1000),
                    int((altitude_change_norm + 1.0) * 500), # 0 to 1000 thrust
                    int(yaw_rate_norm * 1000),
                    0
                )
            except Exception as e:
                pass

    def get_telemetry(self):
        """Returns thread-safe copy of telemetry data."""
        with self.lock:
            return dict(self.telemetry)

    def close(self):
        self.running = False
        if self.master:
            try:
                self.master.close()
            except Exception:
                pass
