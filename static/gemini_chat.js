/**
 * Gemini AI Multimodal Hands-Free Voice, Vision, Mic VU Meter & Gesture Flight Controller
 * Direct Gemini Audio Transcription Pipeline for Pixhawk 4 Drone.
 */

const DEFAULT_GEMINI_KEY = atob('QVEuQWI4Uk42SU9GSDQ4UXNyWWNLLWEzUnp0OFc5RVZiZG0yTHJWRmlnQlE1Y0RySTBjaHc=');

class GeminiDroneAIController {
    constructor(appOrchestrator) {
        this.app = appOrchestrator;
        this.apiKey = localStorage.getItem('GEMINI_API_KEY') || DEFAULT_GEMINI_KEY;
        this.micSensitivity = parseFloat(localStorage.getItem('MIC_SENSITIVITY')) || 100;
        this.isListening = false;
        this.aiSpeaking = false; if (window.AudioHardware) window.AudioHardware.setAiSpeaking(false);
        this.gestureActive = true;

        this.audioContext = null;
        this.analyser = null;
        this.micStream = null;
        this.mediaRecorder = null;
        this.audioChunks = [];

        this.isRecordingAudio = false;
        this.silenceStart = 0;
        this.speechDetected = false;

        this.initDOM();
        this.initSpeechSynthesis();
        this.startGestureLoop();
        this.startCameraStream();

        this.autoStartMicAnalyser();
    }

    initDOM() {
const apiKeyBox = document.getElementById('apiKeyBox');
        if (apiKeyBox && !document.getElementById('selectKeyType')) {
            const select = document.createElement('select');
            select.id = 'selectKeyType';
            select.style.cssText = 'width: 100%; margin-bottom: 6px; padding: 5px 8px; border-radius: 6px; background: #0c2230; color: #7df0ef; border: 1px solid #1f4258; font-size: 12px; cursor: pointer;';
            select.innerHTML = `
                <option value="opencode-go">OpenCode Go API Key</option>
                <option value="gemini">Google Gemini API Key</option>
            `;
            const inputKey = document.getElementById('inputApiKey');
            apiKeyBox.insertBefore(select, inputKey);

            select.addEventListener('change', (e) => {
                if (e.target.value === 'opencode-go') {
                    if (inputKey) inputKey.value = DEFAULT_GEMINI_KEY;
                    this.apiKey = DEFAULT_GEMINI_KEY;
                    localStorage.setItem('GEMINI_API_KEY', DEFAULT_GEMINI_KEY);
                    localStorage.setItem('API_KEY_TYPE', 'opencode-go');
                    this.addMessage('System', 'Inserted OpenCode Go API Key.');
                } else if (e.target.value === 'gemini') {
                    const savedGemini = localStorage.getItem('USER_GEMINI_KEY') || '';
                    if (inputKey) {
                        inputKey.value = savedGemini;
                        inputKey.placeholder = 'Paste Google Gemini API Key...';
                        inputKey.focus();
                    }
                    localStorage.setItem('API_KEY_TYPE', 'gemini');
                }
            });

            const currentType = localStorage.getItem('API_KEY_TYPE') || (this.apiKey.startsWith('AQ.') ? 'opencode-go' : 'gemini');
            select.value = currentType;
        }

        const btnSaveKey = document.getElementById('btnSaveApiKey');
        if (btnSaveKey) {
            btnSaveKey.addEventListener('click', () => {
                const inputKey = document.getElementById('inputApiKey');
                const key = inputKey ? inputKey.value.trim() : '';
                const sel = document.getElementById('selectKeyType');
                if (key) {
                    this.apiKey = key;
                    localStorage.setItem('GEMINI_API_KEY', key);
                    if (sel && sel.value === 'gemini') {
                        localStorage.setItem('USER_GEMINI_KEY', key);
                        localStorage.setItem('API_KEY_TYPE', 'gemini');
                    } else if (key.startsWith('AQ.')) {
                        localStorage.setItem('API_KEY_TYPE', 'opencode-go');
                    }
                    const box = document.getElementById('apiKeyBox');
                    if (box) box.style.display = 'none';
                    this.addMessage('System', (sel && sel.value === 'opencode-go' ? 'OpenCode Go' : 'Gemini') + ' API Key saved!');
                }
            });
        }


        const btnKeySettings = document.getElementById('btnApiKeySettings');
        if (btnKeySettings) {
            btnKeySettings.addEventListener('click', () => {
                const box = document.getElementById('apiKeyBox');
                if (box) box.style.display = box.style.display === 'none' ? 'block' : 'none';
            });
        }

        const btnSend = document.getElementById('btnSendChat');
        if (btnSend) {
            btnSend.addEventListener('click', () => {
                const input = document.getElementById('chatInput');
                if (!input) return;
                const text = input.value.trim();
                if (text) {
                    input.value = '';
                    this.sendPromptToGemini(text);
                }
            });
        }

        const chatInput = document.getElementById('chatInput');
        if (chatInput) {
            chatInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    const text = e.target.value.trim();
                    if (text) {
                        e.target.value = '';
                        this.sendPromptToGemini(text);
                    }
                }
            });
        }

        const btnVision = document.getElementById('btnAskVision');
        if (btnVision) {
            btnVision.addEventListener('click', () => {
                this.sendPromptToGemini('Describe what you see in front of you through your eMeet Pixy camera!');
            });
        }

        const btnMic = document.getElementById('btnMic');
        if (btnMic) {
            btnMic.addEventListener('click', () => {
                if (this.isListening) {
                    this.stopListening();
                } else {
                    this.startListening();
                }
            });
        }

        const slideSens = document.getElementById('slideMicSensitivity');
        const valSens = document.getElementById('valMicSensitivity');
        if (slideSens) {
            slideSens.value = this.micSensitivity;
            if (valSens) valSens.textContent = `${Math.round(this.micSensitivity)}%`;
            slideSens.addEventListener('input', (e) => {
                this.micSensitivity = parseFloat(e.target.value);
                if (valSens) valSens.textContent = `${Math.round(this.micSensitivity)}%`;
                localStorage.setItem('MIC_SENSITIVITY', this.micSensitivity);
            });
        }
    }

    startCameraStream() {
        const img = document.getElementById('camFeed');
        if (!img) return;

        setInterval(() => {
            img.src = `/api/camera/frame?t=${Date.now()}`;
        }, 500);
    }

    autoStartMicAnalyser() {
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            this.startMicAudioAnalyser(false);
        }
    }

    startListening() {
        this.isListening = true;
        this.updateMicUI(true);
        this.startMicAudioAnalyser(true);
    }

    stopListening() {
        this.isListening = false;
        this.isRecordingAudio = false;
        this.updateMicUI(false);

        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            try { this.mediaRecorder.stop(); } catch (e) {}
        }
    }

    updateMicUI(active) {
        const btnMic = document.getElementById('btnMic');
        const statusText = document.getElementById('micStatusText');

        if (!btnMic) return;

        if (active) {
            btnMic.classList.add('active');
            btnMic.style.background = 'var(--accent-red)';
            btnMic.style.borderColor = 'var(--accent-red)';
            btnMic.style.boxShadow = '0 0 12px var(--accent-red)';
            btnMic.textContent = '🔴 Hands-Free ON';
            if (statusText) statusText.textContent = 'Status: Hands-free voice pilot active. Speak commands anytime!';
        } else {
            btnMic.classList.remove('active');
            btnMic.style.background = 'linear-gradient(135deg, rgba(16,185,129,0.25), rgba(0,240,255,0.25))';
            btnMic.style.borderColor = 'var(--accent-green)';
            btnMic.style.boxShadow = '';
            btnMic.textContent = '🎙️ Hands-Free Voice';
            if (statusText) statusText.textContent = 'Status: Click to activate continuous hands-free voice control.';
        }
    }

    startMicAudioAnalyser(userInitiated) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;

        navigator.mediaDevices.getUserMedia({ audio: true })
            .then(stream => {
                this.micStream = stream;
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

                if (this.audioContext.state === 'suspended' && userInitiated) {
                    this.audioContext.resume();
                }

                const source = this.audioContext.createMediaStreamSource(stream);
                this.analyser = this.audioContext.createAnalyser();
                this.analyser.fftSize = 256;
                source.connect(this.analyser);
            const resumeAudio = () => {
                if (this.audioContext && this.audioContext.state === 'suspended') {
                    this.audioContext.resume();
                }
            };
            document.addEventListener('click', resumeAudio, { once: true });
            document.addEventListener('pointerdown', resumeAudio, { once: true });

                const timeData = new Uint8Array(this.analyser.fftSize);
                const vuBar = document.getElementById('micVuBar');
                const vuVal = document.getElementById('vuVal');

                const drawVU = () => {
                    if (!this.analyser) return;

                    this.analyser.getByteFrequencyData(dataArray);
                    let sum = 0;
                    for (let i = 0; i < dataArray.length; i++) {
                        sum += dataArray[i];
                    }
                    const average = sum / dataArray.length;
                    const gain = (this.micSensitivity || 100) / 100;
                    const volumePct = Math.min(100, Math.round((average / 128) * 100 * 2.8 * gain));

                    if (vuBar) {
                        vuBar.style.width = `${volumePct}%`;
                        if (volumePct > 15) {
                            vuBar.style.boxShadow = '0 0 16px var(--accent-red)';
                        } else {
                            vuBar.style.boxShadow = '0 0 8px var(--accent-green)';
                        }
                    }

                    if (vuVal) {
                        vuVal.textContent = `${volumePct}%`;
                        vuVal.style.color = volumePct > 20 ? 'var(--accent-red)' : 'var(--accent-green)';
                    }

                    if (this.isListening && !this.aiSpeaking) {
                        const speechThresh = Math.max(28, Math.round(50 - (this.micSensitivity / 100.0) * 22));
                        if (volumePct >= speechThresh) {
                            this.voicedFrames = (this.voicedFrames || 0) + 1;
                            this.lastHeardVoiceAt = performance.now();
                            this.speechDetected = true;
                            this.silenceStart = 0;

                            if (!this.isRecordingAudio && this.micStream) {
                                this.startAudioChunkRecording();
                            }
                        } else if (this.isRecordingAudio && this.speechDetected) {
                            if (this.silenceStart === 0) {
                                this.silenceStart = performance.now();
                            } else if (performance.now() - this.silenceStart > 380) {
                                this.stopAudioChunkRecordingAndSend();
                            }
                        }
                    }

                    requestAnimationFrame(drawVU);
                };

                drawVU();
            })
            .catch(err => {
                console.error('Microphone access permission error:', err);
                const statusText = document.getElementById('micStatusText');
                if (statusText) statusText.textContent = 'Status: Please allow microphone permission in browser.';
            });
    }

    startAudioChunkRecording() {
        if (!this.micStream) return;
        this.recordingStart = performance.now();
        this.voicedFrames = 0;
        try {
            const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';
            this.mediaRecorder = new MediaRecorder(this.micStream, { mimeType });
            this.audioChunks = [];

            this.mediaRecorder.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) {
                    this.audioChunks.push(e.data);
                }
            };

            this.mediaRecorder.start(100);
            this.isRecordingAudio = true;

            const statusText = document.getElementById('micStatusText');
            if (statusText) statusText.textContent = 'Status: 🎙️ VOICE DETECTED! Recording speech...';
        } catch (err) {
            console.warn('MediaRecorder start error:', err);
        }
    }

    stopAudioChunkRecordingAndSend() {
        if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') return;

        this.isRecordingAudio = false;
        this.speechDetected = false;
        this.silenceStart = 0;

        const statusText = document.getElementById('micStatusText');
        if (statusText) statusText.textContent = 'Status: ⏳ Transcribing voice with Gemini AI...';

        const duration = this.recordingStart ? (performance.now() - this.recordingStart) : 0;
        const voiced = this.voicedFrames || 0;
        this.mediaRecorder.onstop = () => {
            if (this.audioChunks.length > 0) {
                const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';
                const blob = new Blob(this.audioChunks, { type: mimeType });
                if (blob.size >= 2500 && duration >= 300 && voiced >= 2) {
                    this.sendVoiceBlobToGemini(blob, mimeType);
                } else if (this.isListening) {
                    if (statusText) statusText.textContent = 'Status: Listening for speech input...';
                }
            }
        };

        try {
            this.mediaRecorder.stop();
        } catch (e) {}
    }

    sendVoiceBlobToGemini(audioBlob, mimeType) {
        const reader = new FileReader();
        reader.onloadend = () => {
            const base64Audio = reader.result.split(',')[1];

            fetch('/api/gemini/voice', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    audio_b64: base64Audio,
                    mime_type: mimeType,
                    api_key: this.apiKey,
                    include_vision: true
                })
            })
            .then(res => res.json())
            .then(data => {
                const transcribed = (data.transcription || '').trim();
                const hasTrigger = window.AudioHardware ? window.AudioHardware.containsTriggerName(transcribed) : true;
                const projName = window.AudioHardware ? window.AudioHardware.getProjectName() : 'robot';
                if (this.isListening && !hasTrigger && transcribed.length > 0) {
                    console.log(`[Voice] Ignored speech without trigger name '${projName}': "${transcribed}"`);
                    const statusText = document.getElementById('micStatusText');
                    if (statusText && this.isListening) {
                        statusText.textContent = `Status: Heard "${transcribed}" — waiting for "${projName}" anywhere in sentence.`;
                    }
                    return;
                }
                const _dummyTranscribed =  'Spoken Voice Command';
                const reply = data.text || 'No response from Gemini Voice Engine.';

                const chatInput = document.getElementById('chatInput');
                if (chatInput) {
                    chatInput.value = transcribed;
                    chatInput.style.color = 'var(--accent-cyan)';
                }

                this.addMessage('User (Voice)', `🎤 "${transcribed}"`);
                this.addMessage('Gemini AI', reply);
                this.speak(reply);

                const statusText = document.getElementById('micStatusText');
                if (statusText && this.isListening) {
                    statusText.textContent = 'Status: Voice transcribed! Listening for next command...';
                }
            })
            .catch(err => {
                this.addMessage('Error', 'Failed to transcribe voice audio with Gemini.');
                console.error(err);
            });
        };
        reader.readAsDataURL(audioBlob);
    }

    initSpeechSynthesis() {
        this.synth = window.speechSynthesis;
        this.audioPlayer = new Audio();
        this.audioPlayer.crossOrigin = "anonymous";

        this.audioPlayer.onplay = () => { this.aiSpeaking = true; if (window.AudioHardware) window.AudioHardware.setAiSpeaking(true); };
        this.audioPlayer.onended = () => { this.aiSpeaking = false; if (window.AudioHardware) window.AudioHardware.setAiSpeaking(false); };
        this.audioPlayer.onerror = () => { this.aiSpeaking = false; if (window.AudioHardware) window.AudioHardware.setAiSpeaking(false); };
    }

    speak(text) {
        if (!text) return;
        const cleanText = text.replace(/\*[^*]*\*/g, '').trim();
        if (!cleanText) return;

        const encodedText = encodeURIComponent(cleanText);
        this.audioPlayer.src = `/api/tts/speak?text=${encodedText}&voice=ai_female_us`;
        this.audioPlayer.play().catch(err => {
            if (this.synth) {
                const utterance = new SpeechSynthesisUtterance(cleanText);
                utterance.onstart = () => { this.aiSpeaking = true; if (window.AudioHardware) window.AudioHardware.setAiSpeaking(true); };
                utterance.onend = () => { this.aiSpeaking = false; if (window.AudioHardware) window.AudioHardware.setAiSpeaking(false); };
                this.synth.speak(utterance);
            }
        });
    }

    addMessage(sender, text) {
        const history = document.getElementById('chatHistory');
        if (!history) return;

        const msgDiv = document.createElement('div');
        msgDiv.className = `msg ${sender.toLowerCase()}`;
        msgDiv.innerHTML = `<strong>${sender}:</strong> ${text}`;
        history.appendChild(msgDiv);
        history.scrollTop = history.scrollHeight;
    }

    sendPromptToGemini(promptText) {
        this.addMessage('User', promptText);

        fetch('/api/gemini/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt: promptText,
                api_key: this.apiKey,
                include_vision: true
            })
        })
        .then(res => res.json())
        .then(data => {
            const reply = data.text || 'No response from Gemini.';
            this.addMessage('Gemini AI', reply);
            this.speak(reply);
        })
        .catch(err => {
            this.addMessage('Error', 'Failed to reach Gemini AI backend.');
            console.error(err);
        });
    }

    startGestureLoop() {
        setInterval(() => {
            if (!this.gestureActive) return;

            fetch('/api/gemini/gesture', { method: 'POST' })
            .then(res => res.json())
            .then(data => {
                const badge = document.getElementById('gestureBadge');
                if (!badge) return;

                if (data.gesture === '5_FINGERS_TAKEOFF') {
                    badge.textContent = '🖐️ 5 Fingers: Autonomous Takeoff!';
                    badge.style.color = 'var(--accent-green)';
                } else if (data.gesture === '2_FINGERS_YAW') {
                    badge.textContent = '✌️ 2 Fingers: Yaw Rotation';
                    badge.style.color = 'var(--accent-blue)';
                } else if (data.gesture === '1_FINGER_LAND') {
                    badge.textContent = '☝️ 1 Finger: Autonomous Landing';
                    badge.style.color = 'var(--accent-orange)';
                } else {
                    badge.textContent = 'Gesture: Monitoring eMeet Pixy Camera...';
                    badge.style.color = 'var(--accent-cyan)';
                }
            })
            .catch(err => {});
        }, 800);
    }
}
