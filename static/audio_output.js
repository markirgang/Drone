/**
 * Shared audio hardware controller: Microphone, Speaker, Voice & Trigger Name system.
 *
 * Requirements:
 * 1. Low latency: Minimal lag between user finishing speaking and verbal response.
 * 2. Hardware selection: User selects either Browser Computer (Mic & Speaker) OR Local Pi (Mic & Speaker).
 * 3. Half-duplex protection: Only one (mic or speaker) active at the same time to prevent acoustic feedback.
 * 4. Default voice: British Butler voice, with many voices available on both Pi and browser.
 * 5. Project wake/trigger name matching anywhere in continuous sentences.
 */
(function () {
    'use strict';

    const HW_MODE_STORAGE_KEY = 'audio_hardware_mode_v2';
    const SPK_STORAGE_KEY = 'audio_output_target_v1';
    const MIC_STORAGE_KEY = 'audio_input_target_v1';
    const VOICE_STORAGE_KEY = 'audio_voice_preset_v1';

    const DEFAULT_VOICE = 'ai_butler_uk'; // Default British Butler voice

    const SELECT_SPEAKER_IDS = [
        'selectSpeakerSettings', 'selectSpeaker', 'configAudioOutputSelect',
        'browserSpeaker', 'profileSpeakerSelect'
    ];

    const SELECT_MIC_IDS = [
        'selectMicSettings', 'selectMic', 'selectMicDevice',
        'configMicSelect', 'browserMic', 'profileMicDevice', 'profileMicSource'
    ];

    const SELECT_VOICE_IDS = [
        'selectVoice', 'configVoiceSelect', 'configP1VoiceSelect', 'configP2VoiceSelect',
        'browserVoice', 'profileVoiceSelect', 'ttsVoiceSelect'
    ];

    const SHARED_VOICE_PRESETS = [
        { id: 'ai_butler_uk', label: '🎩 British Butler (Polite UK Male)', lang: 'en-GB' },
        { id: 'ai_female_uk', label: '♀️ British Female (Sonia UK)', lang: 'en-GB' },
        { id: 'ai_male_uk', label: '♂️ British Male (Gentleman UK)', lang: 'en-GB' },
        { id: 'ai_female_us', label: '♀️ US Female (Jenny US)', lang: 'en-US' },
        { id: 'ai_male_us', label: '♂️ US Male (Guy US)', lang: 'en-US' },
        { id: 'ai_female_au', label: '♀️ Australian Female (Natasha AU)', lang: 'en-AU' },
        { id: 'ai_male_au', label: '♂️ Australian Male (William AU)', lang: 'en-AU' },
        { id: 'ai_female_ca', label: '♀️ Canadian Female (Clara CA)', lang: 'en-CA' },
        { id: 'ai_male_ca', label: '♂️ Canadian Male (Liam CA)', lang: 'en-CA' },
        { id: 'ai_female_in', label: '♀️ Indian Female (Neerja IN)', lang: 'en-IN' },
        { id: 'ai_male_in', label: '♂️ Indian Male (Prabhat IN)', lang: 'en-IN' },
        { id: 'ai_female_ie', label: '♀️ Irish Female (Emily IE)', lang: 'en-IE' },
        { id: 'ai_male_ie', label: '♂️ Irish Male (Connor IE)', lang: 'en-IE' },
        { id: 'ai_female_za', label: '♀️ South African Female (Leah ZA)', lang: 'en-ZA' },
        { id: 'ai_male_za', label: '♂️ South African Male (Luke ZA)', lang: 'en-ZA' },
        { id: 'ai_female_ng', label: '♀️ Nigerian Female (Ezinne NG)', lang: 'en-NG' },
        { id: 'ai_male_ng', label: '♂️ Nigerian Male (Abeo NG)', lang: 'en-NG' },
        { id: 'ai_female_nz', label: '♀️ New Zealand Female (Molly NZ)', lang: 'en-NZ' },
        { id: 'ai_male_nz', label: '♂️ New Zealand Male (Mitchell NZ)', lang: 'en-NZ' }
    ];

    const PROJECT_TRIGGER_NAMES = {
        'arm': ['arm', 'gripper', 'robotic arm'],
        'bear': ['bear', 'teddy', 'dancing bear'],
        'biped': ['biped', 'humanoid', 'robot'],
        'birds': ['birds', 'bird', 'parakeet', 'cockatoo'],
        'deerhead': ['deerhead', 'buck', 'deer'],
        'dog': ['dog', 'puppy', 'pup', 'spot', 'robodog'],
        'drone': ['drone', 'quadcopter', 'pixhawk'],
        'hand': ['hand', 'robotic hand', 'fingers'],
        'hexapod': ['hexapod', 'spider', 'bug'],
        'fish': ['fish', 'menorah fish', 'menorah'],
        'parrot': ['parrot', 'macaw', 'polly'],
        'rover': ['rover', 'car', 'tank'],
        'tello': ['tello', 'tello drone'],
        'pool': ['pool', 'iggy', 'lighthouse']
    };

    const DYNAMIC_CLASS = 'audio-hw-dynamic';
    const GROUP_CLASS = 'audio-hw-group';
    const originalPlay = HTMLMediaElement.prototype.play;

    let isAiSpeakingNow = false;

    function getHardwareMode() {
        try {
            return localStorage.getItem(HW_MODE_STORAGE_KEY) || 'browser';
        } catch (e) {
            return 'browser';
        }
    }

    function setHardwareMode(mode) {
        try {
            localStorage.setItem(HW_MODE_STORAGE_KEY, mode === 'local' ? 'local' : 'browser');
        } catch (e) {}

        if (mode === 'local') {
            setSpeakerTarget('local:default');
            setMicTarget('local:default');
            showAudioNotice('Switched active audio to Local Raspberry Pi Hardware (Pi Mic & Pi Speaker).');
        } else {
            setSpeakerTarget('remote:');
            setMicTarget('remote:');
            showAudioNotice('Switched active audio to Browser Computer Hardware (Browser Mic & Browser Speaker).');
        }
        populate();
    }

    function getSpeakerSelects() {
        return SELECT_SPEAKER_IDS
            .map(function (id) { return document.getElementById(id); })
            .filter(Boolean);
    }

    function getMicSelects() {
        return SELECT_MIC_IDS
            .map(function (id) { return document.getElementById(id); })
            .filter(Boolean);
    }

    function getVoiceSelects() {
        return SELECT_VOICE_IDS
            .map(function (id) { return document.getElementById(id); })
            .filter(Boolean);
    }

    function getSpeakerTarget() {
        try {
            return localStorage.getItem(SPK_STORAGE_KEY) || 'remote:';
        } catch (e) {
            return 'remote:';
        }
    }

    function getMicTarget() {
        try {
            return localStorage.getItem(MIC_STORAGE_KEY) || localStorage.getItem('MIC_DEVICE') || 'remote:';
        } catch (e) {
            return 'remote:';
        }
    }

    function getVoicePreset() {
        try {
            return localStorage.getItem('AI_VOICE') || localStorage.getItem(VOICE_STORAGE_KEY) || DEFAULT_VOICE;
        } catch (e) {
            return DEFAULT_VOICE;
        }
    }

    function setVoicePreset(val) {
        try {
            localStorage.setItem('AI_VOICE', val || DEFAULT_VOICE);
            localStorage.setItem(VOICE_STORAGE_KEY, val || DEFAULT_VOICE);
        } catch (e) {}
    }

    const LEGACY_LOCAL_TARGETS = [
        'default', 'usb_audio', 'usb_speaker', 'aux_35mm', 'audio_jack',
        'hdmi', 'hdmi_audio', 'bluetooth_speaker', 'emeet_pixy_speaker', 'local',
        'emeet_pixy', 'usb_mic'
    ];

    function isLocalTarget(value) {
        return typeof value === 'string' &&
            (value.indexOf('local:') === 0 || LEGACY_LOCAL_TARGETS.indexOf(value) !== -1);
    }

    function localId(value) {
        return typeof value === 'string' && value.indexOf('local:') === 0 ? value.substring(6) : (value || 'default');
    }

    function isRemoteTarget(value) {
        return typeof value === 'string' && value.indexOf('remote:') === 0;
    }

    function localValue(id) {
        return 'local:' + id;
    }

    function remoteValue(id) {
        return 'remote:' + id;
    }

    function showAudioNotice(msg) {
        if (typeof document === 'undefined') return;
        var banner = document.getElementById('audioHardwareNotice');
        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'audioHardwareNotice';
            banner.style.cssText = 'position:fixed; bottom:20px; right:20px; background:#0f172a; color:#38bdf8; border:1px solid #0284c7; padding:10px 16px; border-radius:8px; font-size:12px; z-index:99999; box-shadow:0 4px 12px rgba(0,0,0,0.5); transition:opacity 0.3s ease;';
            document.body.appendChild(banner);
        }
        banner.textContent = msg;
        banner.style.opacity = '1';
        clearTimeout(banner._timer);
        banner._timer = setTimeout(function () {
            banner.style.opacity = '0';
            setTimeout(function () { if (banner && banner.parentNode) banner.parentNode.removeChild(banner); }, 300);
        }, 4000);
    }

    function setSpeakerTarget(value) {
        try {
            localStorage.setItem(SPK_STORAGE_KEY, value || 'remote:');
        } catch (e) {}
        // Align mode
        if (isLocalTarget(value)) {
            try { localStorage.setItem(HW_MODE_STORAGE_KEY, 'local'); } catch (e) {}
        } else {
            try { localStorage.setItem(HW_MODE_STORAGE_KEY, 'browser'); } catch (e) {}
        }
    }

    function setMicTarget(value) {
        try {
            localStorage.setItem(MIC_STORAGE_KEY, value || 'remote:');
            localStorage.setItem('MIC_DEVICE', value || 'remote:');
        } catch (e) {}
        // Align mode
        if (isLocalTarget(value)) {
            try { localStorage.setItem(HW_MODE_STORAGE_KEY, 'local'); } catch (e) {}
        } else {
            try { localStorage.setItem(HW_MODE_STORAGE_KEY, 'browser'); } catch (e) {}
        }
    }

    // Half-duplex state management: only one (mic or speaker) active at the same time
    function setAiSpeaking(speaking) {
        isAiSpeakingNow = Boolean(speaking);
        // If speaking, temporarily mute browser microphone tracks so robot never hears itself
        if (window._globalMicStream) {
            window._globalMicStream.getAudioTracks().forEach(function (t) {
                t.enabled = !isAiSpeakingNow;
            });
        }
    }

    function isAiSpeaking() {
        return isAiSpeakingNow;
    }

    // Intercept media playback for local vs. remote speakers
    HTMLMediaElement.prototype.play = function () {
        const target = getSpeakerTarget();

        // Enforce half-duplex: AI starts speaking -> mic muted
        setAiSpeaking(true);
        const onEnd = function () { setAiSpeaking(false); };
        this.addEventListener('ended', onEnd, { once: true });
        this.addEventListener('pause', onEnd, { once: true });
        this.addEventListener('error', onEnd, { once: true });

        if (isLocalTarget(target)) {
            const src = this.currentSrc || this.src;
            const sink = localId(target);
            if (src) {
                try { this.pause(); } catch (e) {}
                const volume = Math.round((typeof this.volume === 'number' ? this.volume : 1) * 100);
                fetch('/api/audio/play', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: src, speaker: sink, volume: volume })
                }).catch(function () {});
                return Promise.resolve();
            }
        }

        if (isRemoteTarget(target) && typeof this.setSinkId === 'function') {
            const sinkId = target.substring(7);
            if (sinkId) {
                return this.setSinkId(sinkId).catch(function () {}).then(function () {
                    return originalPlay.call(this);
                }.bind(this));
            }
        }

        return originalPlay.call(this);
    };

    // AudioContext wrapping for remote speaker routing
    ['AudioContext', 'webkitAudioContext'].forEach(function (name) {
        const Original = window[name];
        if (!Original) return;

        function WrappedAudioContext() {
            const ctx = new Original(...arguments);
            const target = getSpeakerTarget();
            if (isRemoteTarget(target) && typeof ctx.setSinkId === 'function') {
                ctx.setSinkId(target.substring(7)).catch(function () {});
            }
            return ctx;
        }

        WrappedAudioContext.prototype = Original.prototype;
        window[name] = WrappedAudioContext;
    });

    let remoteCache = null;

    async function getRemoteDevices() {
        if (remoteCache) return remoteCache;
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
            return { inputs: [], outputs: [] };
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(function () {
                return null;
            });
            if (stream) {
                window._globalMicStream = stream;
                stream.getTracks().forEach(function (track) { track.stop(); });
            }
            const devices = await navigator.mediaDevices.enumerateDevices();
            remoteCache = {
                inputs: devices.filter(function (d) { return d.kind === 'audioinput'; }),
                outputs: devices.filter(function (d) { return d.kind === 'audiooutput'; })
            };
            return remoteCache;
        } catch (e) {
            return { inputs: [], outputs: [] };
        }
    }

    async function getLocalOutputs() {
        try {
            const response = await fetch('/api/audio/outputs', { cache: 'no-store' });
            if (!response.ok) return [];
            const data = await response.json();
            return Array.isArray(data.outputs) ? data.outputs : [];
        } catch (e) {
            return [];
        }
    }

    async function getLocalInputs() {
        try {
            const response = await fetch('/api/audio/inputs', { cache: 'no-store' });
            if (!response.ok) return [];
            const data = await response.json();
            return Array.isArray(data.inputs) ? data.inputs : [];
        } catch (e) {
            return [];
        }
    }

    function clearDynamicOptions(select) {
        select.querySelectorAll('option.' + DYNAMIC_CLASS + ', optgroup.' + GROUP_CLASS)
            .forEach(function (node) { node.remove(); });
    }

    function appendGroup(select, label, entries, selectedValue) {
        if (!entries || !entries.length) return;

        const group = document.createElement('optgroup');
        group.className = GROUP_CLASS;
        group.label = label;

        entries.forEach(function (entry) {
            const option = document.createElement('option');
            option.className = DYNAMIC_CLASS;
            option.value = entry.value;
            option.textContent = entry.label;
            if (entry.value === selectedValue) option.selected = true;
            group.appendChild(option);
        });

        select.appendChild(group);
    }

    async function populateSpeakers() {
        const selects = getSpeakerSelects();
        if (!selects.length) return;

        const results = await Promise.all([getRemoteDevices(), getLocalOutputs()]);
        const remoteOutputs = results[0].outputs || [];
        const localOutputs = results[1] || [];

        selects.forEach(function (select) {
            let target = getSpeakerTarget() || select.value || 'remote:';
            clearDynamicOptions(select);

            appendGroup(select, '🌐 Remote Computer Speakers (This Browser)',
                [
                    { value: 'remote:', label: '🌐 Browser Default Speaker (This Computer)' }
                ].concat(remoteOutputs.map(function (device, index) {
                    return {
                        value: remoteValue(device.deviceId),
                        label: '🌐 ' + (device.label || ('Remote Speaker ' + (index + 1))) + ' (This Computer)'
                    };
                })), target);

            appendGroup(select, '🔊 Local Device Speakers (Raspberry Pi Server)',
                localOutputs.map(function (device, index) {
                    return {
                        value: localValue(device.id),
                        label: '🔊 ' + (device.label || ('Local Speaker ' + (index + 1))) +
                            (device.default ? ' (Default)' : '') + ' (Raspberry Pi)'
                    };
                }), target);

            const options = Array.from(select.options);
            if (target && options.some(function (opt) { return opt.value === target; })) {
                select.value = target;
            } else if (options.length) {
                select.value = options[0].value;
            }
        });
    }

    async function populateMicrophones() {
        const selects = getMicSelects();
        if (!selects.length) return;

        const results = await Promise.all([getRemoteDevices(), getLocalInputs()]);
        const remoteInputs = results[0].inputs || [];
        const localInputs = results[1] || [];

        selects.forEach(function (select) {
            let target = getMicTarget() || select.value || 'remote:';
            clearDynamicOptions(select);

            appendGroup(select, '🌐 Remote Computer Microphones (This Browser)',
                [
                    { value: 'remote:', label: '🌐 Browser Default Microphone (This Computer)' }
                ].concat(remoteInputs.map(function (device, index) {
                    return {
                        value: remoteValue(device.deviceId),
                        label: '🌐 ' + (device.label || ('Microphone ' + (index + 1))) + ' (This Computer)'
                    };
                })), target);

            appendGroup(select, '🎙️ Local Device Microphones (Raspberry Pi Server)',
                localInputs.map(function (device, index) {
                    return {
                        value: localValue(device.id),
                        label: '🎙️ ' + (device.label || ('Local Mic ' + (index + 1))) +
                            (device.default ? ' (Default)' : '') + ' (Raspberry Pi)'
                    };
                }), target);

            const options = Array.from(select.options);
            if (target && options.some(function (opt) { return opt.value === target; })) {
                select.value = target;
            } else if (options.length) {
                select.value = options[0].value;
            }
        });
    }

    function populateVoices() {
        const selects = getVoiceSelects();
        if (!selects.length) return;
        const current = getVoicePreset();

        selects.forEach(function (select) {
            const existingValues = Array.from(select.options).map(function (o) { return o.value; });
            const hasPresets = existingValues.indexOf('ai_butler_uk') !== -1;
            if (!hasPresets || select.options.length < 8) {
                select.innerHTML = '';
                SHARED_VOICE_PRESETS.forEach(function (v) {
                    const opt = document.createElement('option');
                    opt.value = v.id;
                    opt.textContent = v.label;
                    if (v.id === current) opt.selected = true;
                    select.appendChild(opt);
                });
            }
            if (current && Array.from(select.options).some(function (o) { return o.value === current; })) {
                select.value = current;
            }
        });
    }

    async function populate() {
        await Promise.all([populateSpeakers(), populateMicrophones()]);
        populateVoices();
    }

    function detectProjectKey() {
        if (window.PROJECT_NAME) return String(window.PROJECT_NAME).toLowerCase();
        if (window.ROBOT_NAME) return String(window.ROBOT_NAME).toLowerCase();

        const path = (window.location.pathname || '').toLowerCase();
        const host = (window.location.hostname || '').toLowerCase();
        const title = (document.title || '').toLowerCase();

        const keys = [
            'parrot', 'bear', 'birds', 'hexapod', 'rover', 'arm', 'dog',
            'drone', 'deerhead', 'tello', 'fish', 'hand', 'biped', 'pool'
        ];
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            if (host.indexOf(k) !== -1 || path.indexOf('/' + k) !== -1 || title.indexOf(k) !== -1) {
                return k;
            }
        }
        if (title.indexOf('bird') !== -1) return 'birds';
        if (title.indexOf('menorah') !== -1) return 'fish';
        return 'robot';
    }

    function getProjectTriggerNames() {
        const key = detectProjectKey();
        return PROJECT_TRIGGER_NAMES[key] || [key];
    }

    function containsTriggerName(sentence) {
        if (!sentence || typeof sentence !== 'string') return false;
        const names = getProjectTriggerNames();
        const lower = sentence.toLowerCase();
        return names.some(function (n) {
            const rx = new RegExp('\\b' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
            return rx.test(lower);
        });
    }

    function initialize() {
        getSpeakerSelects().forEach(function (select) {
            select.addEventListener('change', function () {
                setSpeakerTarget(select.value);
            });
        });

        getMicSelects().forEach(function (select) {
            select.addEventListener('change', function () {
                setMicTarget(select.value);
            });
        });

        getVoiceSelects().forEach(function (select) {
            select.addEventListener('change', function () {
                setVoicePreset(select.value);
            });
        });

        if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
            navigator.mediaDevices.addEventListener('devicechange', function () {
                remoteCache = null;
                populate();
            });
        }

        populate();
        [300, 1000, 2500].forEach(function (delay) {
            setTimeout(populate, delay);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }

    // Intercept fetch calls to /api/gemini/voice to route local mic if chosen
    const originalFetch = window.fetch;
    window.fetch = function (resource, options) {
        if (typeof resource === 'string' && resource.indexOf('/api/gemini/voice') !== -1 && options && options.body) {
            try {
                const micTarget = getMicTarget();
                if (isLocalTarget(micTarget)) {
                    let payload = JSON.parse(options.body);
                    payload.use_local_mic = true;
                    payload.source = 'local';
                    payload.mic_device = localId(micTarget);
                    options.body = JSON.stringify(payload);
                }
            } catch (e) {}
        }
        return originalFetch.apply(this, arguments);
    };

    window.AudioHardware = {
        populate: populate,
        refresh: populate,
        populateVoices: populateVoices,
        getHardwareMode: getHardwareMode,
        setHardwareMode: setHardwareMode,
        getSpeakerTarget: getSpeakerTarget,
        setSpeakerTarget: setSpeakerTarget,
        getMicTarget: getMicTarget,
        setMicTarget: setMicTarget,
        getVoicePreset: getVoicePreset,
        setVoicePreset: setVoicePreset,
        getVoices: function () { return SHARED_VOICE_PRESETS; },
        isLocalSpeaker: function () { return isLocalTarget(getSpeakerTarget()); },
        isLocalMic: function () { return isLocalTarget(getMicTarget()); },
        setAiSpeaking: setAiSpeaking,
        isAiSpeaking: isAiSpeaking,
        getProjectName: detectProjectKey,
        getTriggerNames: getProjectTriggerNames,
        containsTriggerName: containsTriggerName
    };

    window.AudioOutputDevices = {
        populate: populate,
        refresh: populate,
        getTarget: getSpeakerTarget,
        setTarget: setSpeakerTarget,
        getMicTarget: getMicTarget,
        setMicTarget: setMicTarget
    };
})();
