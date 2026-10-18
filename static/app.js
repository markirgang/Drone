/**
 * Main Application Orchestrator for Pixhawk 4 Drone Command Center
 */

class DroneApp {
    constructor() {
        this.renderer = null;
        this.gemini = null;
        this.telemetry = {
            armed: false,
            mode: "POSCTL",
            roll: 0,
            pitch: 0,
            yaw: 0,
            heading: 0,
            altitude: 0,
            climb_rate: 0,
            groundspeed: 0,
            airspeed: 0,
            battery_voltage: 16.8,
            battery_percentage: 98,
            gps_fix_type: 3,
            satellites: 14,
            latitude: 37.774929,
            longitude: -122.419416,
            is_connected: true,
            is_simulation: true
        };

        this.init3DRenderer();
        this.initNavTabs();
        this.initFlightButtons();
        this.initKeyboardControls();
        this.initSettingsHandlers();
        this.initPdfHandlers();
        this.startTelemetryLoop();

        this.gemini = new GeminiDroneAIController(this);
    }

    init3DRenderer() {
        this.renderer = new Drone3DRenderer('viewport3d');
    }

    initNavTabs() {
        const tabs = document.querySelectorAll('.nav-tab-btn');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');

                const targetViewId = tab.getAttribute('data-view');
                document.querySelectorAll('.view-screen').forEach(view => {
                    view.classList.remove('active');
                    view.style.display = 'none';
                });
                const targetView = document.getElementById(targetViewId);
                if (targetView) {
                    targetView.classList.add('active');
                    if (targetViewId === 'viewWiring' || targetViewId === 'viewInstructions') {
                        targetView.style.display = 'block';
                    } else if (targetViewId === 'viewSettings' || targetViewId === 'viewMission') {
                        targetView.style.display = 'flex';
                    } else {
                        targetView.style.display = 'grid';
                    }
                }

                if (targetViewId === 'viewAnimation' && this.renderer) {
                    this.renderer.onWindowResize();
                }
            });
        });
    }

    initFlightButtons() {
        // Arm & Disarm
        document.getElementById('btnArm')?.addEventListener('click', () => {
            fetch('/api/drone/arm', { method: 'POST' }).then(() => this.pollTelemetry());
        });

        document.getElementById('btnDisarm')?.addEventListener('click', () => {
            fetch('/api/drone/disarm', { method: 'POST' }).then(() => this.pollTelemetry());
        });

        // Takeoff
        const slideAlt = document.getElementById('slideTargetAlt');
        const valAlt = document.getElementById('valTargetAlt');
        if (slideAlt && valAlt) {
            slideAlt.addEventListener('input', (e) => {
                valAlt.textContent = `${parseFloat(e.target.value).toFixed(1)} m`;
            });
        }

        document.getElementById('btnTakeoff')?.addEventListener('click', () => {
            const alt = parseFloat(slideAlt ? slideAlt.value : 2.5);
            fetch('/api/drone/takeoff', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ altitude: alt })
            }).then(() => this.pollTelemetry());
        });

        // Land, RTL, Hold, Offboard
        document.getElementById('btnLand')?.addEventListener('click', () => {
            fetch('/api/drone/land', { method: 'POST' }).then(() => this.pollTelemetry());
        });

        document.getElementById('btnRTL')?.addEventListener('click', () => {
            fetch('/api/drone/rtl', { method: 'POST' }).then(() => this.pollTelemetry());
        });

        document.getElementById('btnHold')?.addEventListener('click', () => {
            fetch('/api/drone/mode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: 'HOLD' })
            }).then(() => this.pollTelemetry());
        });

        document.getElementById('btnOffboard')?.addEventListener('click', () => {
            fetch('/api/drone/mode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: 'OFFBOARD' })
            }).then(() => this.pollTelemetry());
        });

        // Mode Selector
        const selectMode = document.getElementById('selectFlightMode');
        if (selectMode) {
            selectMode.addEventListener('change', (e) => {
                fetch('/api/drone/mode', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode: e.target.value })
                }).then(() => this.pollTelemetry());
            });
        }

        // Viewport Camera Controls
        document.getElementById('btnResetCam')?.addEventListener('click', () => this.renderer?.setCameraPreset('default'));
        document.getElementById('btnTopCam')?.addEventListener('click', () => this.renderer?.setCameraPreset('top'));
        document.getElementById('btnChaserCam')?.addEventListener('click', () => this.renderer?.setCameraPreset('chaser'));

        // Virtual D-Pad buttons
        this.bindDpad('btnFwd', 1.0, 0.0, 0.0, 0.0);
        this.bindDpad('btnBwd', -1.0, 0.0, 0.0, 0.0);
        this.bindDpad('btnLeft', 0.0, -1.0, 0.0, 0.0);
        this.bindDpad('btnRight', 0.0, 1.0, 0.0, 0.0);
        this.bindDpad('btnTurnL', 0.0, 0.0, -1.0, 0.0);
        this.bindDpad('btnTurnR', 0.0, 0.0, 1.0, 0.0);
        this.bindDpad('btnStop', 0.0, 0.0, 0.0, 0.0);

        // Export Python Script
        document.getElementById('btnExportScript')?.addEventListener('click', () => {
            window.location.href = '/api/export-python';
        });
    }

    bindDpad(id, pitch, roll, yaw, alt_rate) {
        const btn = document.getElementById(id);
        if (!btn) return;

        const sendVector = () => {
            fetch('/api/drone/manual', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pitch, roll, yaw, altitude_rate: alt_rate })
            });
        };

        btn.addEventListener('mousedown', sendVector);
        btn.addEventListener('mouseup', () => {
            fetch('/api/drone/manual', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pitch: 0, roll: 0, yaw: 0, altitude_rate: 0 })
            });
        });
    }

    initKeyboardControls() {
        const activeKeys = {};

        window.addEventListener('keydown', (e) => {
            if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;

            const key = e.key.toLowerCase();
            activeKeys[key] = true;

            let pitch = 0, roll = 0, yaw = 0, alt_rate = 0;

            if (activeKeys['w']) pitch += 1.0;
            if (activeKeys['s']) pitch -= 1.0;
            if (activeKeys['a']) roll -= 1.0;
            if (activeKeys['d']) roll += 1.0;
            if (activeKeys['q']) yaw -= 1.0;
            if (activeKeys['e']) yaw += 1.0;
            if (activeKeys['arrowup']) alt_rate += 1.0;
            if (activeKeys['arrowdown']) alt_rate -= 1.0;

            fetch('/api/drone/manual', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pitch, roll, yaw, altitude_rate: alt_rate })
            });
        });

        window.addEventListener('keyup', (e) => {
            const key = e.key.toLowerCase();
            activeKeys[key] = false;

            fetch('/api/drone/manual', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pitch: 0, roll: 0, yaw: 0, altitude_rate: 0 })
            });
        });
    }

    initSettingsHandlers() {
        document.getElementById('btnConnectMavlink')?.addEventListener('click', () => {
            const port = document.getElementById('selectSerialPort')?.value;
            const baud = document.getElementById('selectBaudRate')?.value;
            alert(`Configured MAVLink Serial: ${port} @ ${baud} baud. System automatically auto-connects to Pixhawk.`);
        });

        document.getElementById('btnSaveSettings')?.addEventListener('click', () => {
            const apiKey = document.getElementById('settingsApiKey')?.value;
            if (apiKey) {
                localStorage.setItem('GEMINI_API_KEY', apiKey);
                alert('Settings saved successfully!');
            }
        });
    }

    initPdfHandlers() {
        const setupPdfHandler = (btnId, elementSelector, filename) => {
            const btn = document.getElementById(btnId);
            if (!btn) return;
            btn.addEventListener('click', async () => {
                const element = document.querySelector(elementSelector);
                if (!element) return;

                const origText = btn.innerHTML;
                btn.innerHTML = '⏳ Exporting PDF...';
                btn.disabled = true;

                document.body.classList.add('exporting-pdf');

                const opt = {
                    margin: [8, 8, 8, 8],
                    filename: filename,
                    image: { type: 'jpeg', quality: 0.98 },
                    html2canvas: {
                        scale: 2,
                        useCORS: true,
                        logging: false,
                        backgroundColor: '#0f172a'
                    },
                    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
                    pagebreak: { mode: ['avoid-all', 'css', 'legacy'] }
                };

                try {
                    if (window.html2pdf) {
                        await html2pdf().set(opt).from(element).save();
                    } else {
                        window.print();
                    }
                } catch (err) {
                    console.error("PDF generation error, falling back to print:", err);
                    window.print();
                } finally {
                    document.body.classList.remove('exporting-pdf');
                    btn.innerHTML = origText;
                    btn.disabled = false;
                }
            });
        };

        setupPdfHandler('btnExportWiringPDF', '#viewWiring .wiring-container', 'Pixhawk4_Drone_Wiring_Schematic.pdf');
        setupPdfHandler('btnExportInstructionsPDF', '#viewInstructions .guide-wrapper', 'Pixhawk4_Drone_Operating_Manual.pdf');

        document.getElementById('btnPrintWiringPDF')?.addEventListener('click', () => window.print());
        document.getElementById('btnPrintInstructionsPDF')?.addEventListener('click', () => window.print());

        document.getElementById('btnExportWiringScript')?.addEventListener('click', () => {
            document.getElementById('btnExportScript')?.click();
        });
    }

    startTelemetryLoop() {
        setInterval(() => this.pollTelemetry(), 100);
    }

    pollTelemetry() {
        fetch('/api/telemetry')
            .then(res => res.json())
            .then(data => {
                this.telemetry = data;
                this.updateUI();
            })
            .catch(() => {});
    }

    updateUI() {
        const t = this.telemetry;

        // 3D Model Update
        if (this.renderer) {
            this.renderer.updatePose(t.pitch, t.roll, t.yaw, t.altitude, t.armed);
        }

        // Header Status Badges
        const dotMav = document.getElementById('dotMavlink');
        const textMav = document.getElementById('textMavlink');
        if (dotMav && textMav) {
            if (t.is_simulation) {
                dotMav.className = 'status-dot sim';
                textMav.textContent = 'SIMULATION MODE';
            } else if (t.is_connected) {
                dotMav.className = 'status-dot';
                textMav.textContent = 'MAVLINK ONLINE';
            } else {
                dotMav.className = 'status-dot disarmed';
                textMav.textContent = 'CONNECTING...';
            }
        }

        const dotArm = document.getElementById('dotArmState');
        const textArm = document.getElementById('textArmState');
        if (dotArm && textArm) {
            if (t.armed) {
                dotArm.className = 'status-dot';
                textArm.textContent = 'ARMED';
                textArm.style.color = 'var(--accent-green)';
            } else {
                dotArm.className = 'status-dot disarmed';
                textArm.textContent = 'DISARMED';
                textArm.style.color = 'var(--accent-orange)';
            }
        }

        // HUD Overlay
        document.getElementById('hudAlt').textContent = `${t.altitude.toFixed(1)} m`;
        document.getElementById('hudClimb').textContent = `${t.climb_rate.toFixed(1)} m/s`;
        document.getElementById('hudSpeed').textContent = `${t.groundspeed.toFixed(1)} m/s`;
        document.getElementById('hudAirspeed').textContent = `${t.airspeed.toFixed(1)} m/s`;
        document.getElementById('hudHeading').textContent = `${t.heading.toFixed(0)}°`;
        document.getElementById('hudBattery').textContent = `${t.battery_voltage.toFixed(1)}V (${t.battery_percentage.toFixed(0)}%)`;

        // Telemetry Grid
        document.getElementById('telemAttitude').textContent = `${t.pitch.toFixed(1)}° / ${t.roll.toFixed(1)}°`;
        document.getElementById('telemHeading').textContent = `${t.heading.toFixed(1)}° (${t.yaw.toFixed(1)}°)`;
        document.getElementById('telemAlt').textContent = `${t.altitude.toFixed(1)}m (${t.climb_rate.toFixed(1)}m/s)`;
        document.getElementById('telemBattery').textContent = `${t.battery_voltage.toFixed(1)}V (${t.battery_percentage.toFixed(0)}%)`;
        document.getElementById('telemGps').textContent = `3D Fix (${t.satellites} Sats)`;
        document.getElementById('telemCoords').textContent = `${t.latitude.toFixed(5)}, ${t.longitude.toFixed(5)}`;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.droneApp = new DroneApp();
});
