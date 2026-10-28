/**
 * Shared speaker / audio output selection.
 *
 * Populates the hardware-settings speaker dropdown with:
 *   - Every audio output exposed by the currently connected browser (remote device).
 *   - Every audio sink exposed by the Raspberry Pi server (local device).
 *
 * Selecting a remote device routes browser playback through HTMLMediaElement.setSinkId().
 * Selecting a local device asks the server to play the audio on that sink.
 */
(function () {
    'use strict';

    const STORAGE_KEY = 'audio_output_target_v1';
    const SELECT_IDS = ['selectSpeakerSettings', 'selectSpeaker', 'configAudioOutputSelect'];
    const DYNAMIC_CLASS = 'audio-output-dynamic';
    const GROUP_CLASS = 'audio-output-group';
    const originalPlay = HTMLMediaElement.prototype.play;

    function getSelects() {
        return SELECT_IDS
            .map(function (id) { return document.getElementById(id); })
            .filter(Boolean);
    }

    function getTarget() {
        try {
            return localStorage.getItem(STORAGE_KEY) || '';
        } catch (e) {
            return '';
        }
    }

    function setTarget(value) {
        try {
            localStorage.setItem(STORAGE_KEY, value || '');
        } catch (e) {}
    }

    const LEGACY_LOCAL_TARGETS = [
        'default', 'usb_audio', 'usb_speaker', 'aux_35mm', 'audio_jack',
        'hdmi', 'hdmi_audio', 'bluetooth_speaker', 'emeet_pixy_speaker', 'local'
    ];

    function isLocalTarget(value) {
        return typeof value === 'string' &&
            (value.indexOf('local:') === 0 || LEGACY_LOCAL_TARGETS.indexOf(value) !== -1);
    }

    function localSinkId(value) {
        return value.indexOf('local:') === 0 ? value.substring(6) : '';
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

    // Route all media element playback to the selected remote sink. When a local
    // sink is selected, ask the server to play the clip on the Pi speaker instead.
    HTMLMediaElement.prototype.play = function () {
        const target = getTarget();

        if (isLocalTarget(target)) {
            const src = this.currentSrc || this.src;
            const sink = localSinkId(target);
            if (src) {
                try { this.pause(); } catch (e) {}
                fetch('/api/audio/play', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: src, speaker: sink, volume: 100 })
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

    // AudioContext is used by the settings test chime and by some visualisers.
    ['AudioContext', 'webkitAudioContext'].forEach(function (name) {
        const Original = window[name];
        if (!Original) return;

        function WrappedAudioContext() {
            const ctx = new Original(...arguments);
            const target = getTarget();
            if (isRemoteTarget(target) && typeof ctx.setSinkId === 'function') {
                ctx.setSinkId(target.substring(7)).catch(function () {});
            }
            return ctx;
        }

        WrappedAudioContext.prototype = Original.prototype;
        window[name] = WrappedAudioContext;
    });

    let remoteOutputCache = null;

    async function getRemoteOutputs() {
        if (remoteOutputCache) return remoteOutputCache;
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
            return [];
        }
        try {
            // A short-lived permission request unlocks human-readable device labels.
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(function () {
                return null;
            });
            if (stream) {
                stream.getTracks().forEach(function (track) { track.stop(); });
            }
            const devices = await navigator.mediaDevices.enumerateDevices();
            remoteOutputCache = devices.filter(function (device) {
                return device.kind === 'audiooutput';
            });
            return remoteOutputCache;
        } catch (e) {
            return [];
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

    function clearDynamicOptions(select) {
        select.querySelectorAll('option.' + DYNAMIC_CLASS + ', optgroup.' + GROUP_CLASS)
            .forEach(function (node) { node.remove(); });
    }

    function appendGroup(select, label, entries, selectedValue) {
        if (!entries.length) return;

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

    async function populate() {
        const selects = getSelects();
        if (!selects.length) return;

        const results = await Promise.all([getRemoteOutputs(), getLocalOutputs()]);
        const remoteDevices = results[0];
        const localDevices = results[1];

        selects.forEach(function (select) {
            const target = getTarget() || select.value || 'browser';
            clearDynamicOptions(select);

            appendGroup(select, '🌐 Remote Computer Speakers (This Browser)',
                remoteDevices.map(function (device, index) {
                    return {
                        value: remoteValue(device.deviceId),
                        label: '🌐 ' + (device.label || ('Remote Speaker ' + (index + 1))) + ' (This Computer)'
                    };
                }), target);

            appendGroup(select, '🔊 Local Device Speakers (Raspberry Pi Server)',
                localDevices.map(function (device, index) {
                    return {
                        value: localValue(device.id),
                        label: '🔊 ' + (device.label || ('Local Speaker ' + (index + 1))) +
                            (device.default ? ' (Default)' : '') + ' (Raspberry Pi)'
                    };
                }), target);

            const options = Array.from(select.options);
            if (target && options.some(function (option) { return option.value === target; })) {
                select.value = target;
            } else if (options.length) {
                select.value = options[0].value;
            }
        });
    }

    function initialize() {
        getSelects().forEach(function (select) {
            select.addEventListener('change', function () {
                setTarget(select.value);
            });
        });

        if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
            navigator.mediaDevices.addEventListener('devicechange', function () {
                remoteOutputCache = null;
                populate();
            });
        }

        populate();
        // Some project scripts restore their own saved settings after load; re-apply
        // the speaker selection once those async configuration fetches have finished.
        [300, 1200, 2500].forEach(function (delay) {
            setTimeout(populate, delay);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }

    window.AudioOutputDevices = {
        populate: populate,
        refresh: populate,
        getTarget: getTarget,
        setTarget: setTarget
    };
})();
