/**
 * Shared audio hardware controller: Microphone and Speaker selection.
 *
 * Populates hardware settings dropdowns with:
 *   - Remote browser computer microphones and speakers (this computer / client).
 *   - Local Raspberry Pi hardware microphones and speakers (robot server).
 *
 * Handles routing:
 *   - Local speaker: Routes playback to Raspberry Pi hardware via /api/audio/play
 *   - Remote speaker: Routes playback to client browser speakers via HTMLMediaElement.setSinkId()
 *   - Local mic: Directs voice requests to Raspberry Pi local mic hardware via /api/gemini/voice
 *   - Remote mic: Routes voice capture through browser client microphone via getUserMedia
 */
(function () {
    'use strict';

    const SPK_STORAGE_KEY = 'audio_output_target_v1';
    const MIC_STORAGE_KEY = 'audio_input_target_v1';

    const SELECT_SPEAKER_IDS = [
        'selectSpeakerSettings', 'selectSpeaker', 'configAudioOutputSelect',
        'browserSpeaker', 'profileSpeakerSelect'
    ];

    const SELECT_MIC_IDS = [
        'selectMicSettings', 'selectMic', 'selectMicDevice',
        'configMicSelect', 'browserMic', 'profileMicDevice', 'profileMicSource'
    ];

    const DYNAMIC_CLASS = 'audio-hw-dynamic';
    const GROUP_CLASS = 'audio-hw-group';
    const originalPlay = HTMLMediaElement.prototype.play;

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

    function getSpeakerTarget() {
        try {
            return localStorage.getItem(SPK_STORAGE_KEY) || '';
        } catch (e) {
            return '';
        }
    }

    function setSpeakerTarget(value) {
        try {
            localStorage.setItem(SPK_STORAGE_KEY, value || '');
        } catch (e) {}
    }

    function getMicTarget() {
        try {
            return localStorage.getItem(MIC_STORAGE_KEY) || localStorage.getItem('MIC_DEVICE') || '';
        } catch (e) {
            return '';
        }
    }

    function setMicTarget(value) {
        try {
            localStorage.setItem(MIC_STORAGE_KEY, value || '');
            localStorage.setItem('MIC_DEVICE', value || '');
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

    // Intercept media playback for local vs. remote speakers
    HTMLMediaElement.prototype.play = function () {
        const target = getSpeakerTarget();

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

    // AudioContext wrapping
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
            const target = getSpeakerTarget() || select.value || 'browser';
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
            const target = getMicTarget() || select.value || 'remote:';
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

    async function populate() {
        await Promise.all([populateSpeakers(), populateMicrophones()]);
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
        getSpeakerTarget: getSpeakerTarget,
        setSpeakerTarget: setSpeakerTarget,
        getMicTarget: getMicTarget,
        setMicTarget: setMicTarget,
        isLocalSpeaker: function () { return isLocalTarget(getSpeakerTarget()); },
        isLocalMic: function () { return isLocalTarget(getMicTarget()); }
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
