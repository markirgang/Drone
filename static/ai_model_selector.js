/**
 * AI Model Selector: OpenCode Go, Google Gemini & Ollama Local Models.
 *
 * Discovers available models from /api/models, populates/injects model selection UI,
 * manages provider credentials, and attaches model/provider configuration to all AI requests.
 */
(function () {
    'use strict';

    const MODEL_STORAGE_KEY = 'SELECTED_AI_MODEL';
    const PROVIDER_STORAGE_KEY = 'SELECTED_AI_PROVIDER';
    const DEFAULT_OPENCODE_KEY = atob('QVEuQWI4Uk42SU9GSDQ4UXNyWWNLLWEzUnp0OFc5RVZiZG0yTHJWRmlnQlE1Y0RySTBjaHc=');

    const SELECT_MODEL_IDS = [
        'selectModel', 'selectAiModel', 'selectAiModelSettings', 'aiModelSelect', 'settingModel'
    ];

    const KEY_INPUT_IDS = [
        'settingsApiKey', 'inputApiKey', 'inputApiKeySettings', 'voiceKey', 'inputKeySettings'
    ];

    let cachedModelsData = null;

    function getSelectedModel() {
        return localStorage.getItem(MODEL_STORAGE_KEY) || 'gemini-4-argon';
    }

    function getSelectedProvider() {
        return localStorage.getItem(PROVIDER_STORAGE_KEY) || 'opencode-go';
    }

    function setSelected(provider, model) {
        if (provider) localStorage.setItem(PROVIDER_STORAGE_KEY, provider);
        if (model) localStorage.setItem(MODEL_STORAGE_KEY, model);
        updateHints();
    }

    function findModelSelects() {
        return SELECT_MODEL_IDS
            .map(function (id) { return document.getElementById(id); })
            .filter(Boolean);
    }

    function findKeyInput() {
        for (let i = 0; i < KEY_INPUT_IDS.length; i++) {
            const el = document.getElementById(KEY_INPUT_IDS[i]);
            if (el) return el;
        }
        return null;
    }

    async function fetchModels() {
        if (cachedModelsData) return cachedModelsData;
        try {
            const res = await fetch('/api/models', { cache: 'no-store' });
            if (res.ok) {
                cachedModelsData = await res.json();
                return cachedModelsData;
            }
        } catch (e) {}
        return {
            providers: ['opencode-go', 'google', 'ollama'],
            default_models: {
                'opencode-go': 'gemini-4-argon',
                'google': 'gemini-3.8-flash',
                'ollama': 'llama3.2'
            },
            models: {
                'opencode-go': ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-flash-latest'],
                'google': ['gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-flash-latest', 'gemini-pro-latest'],
                'ollama': ['llama3.2', 'mistral', 'qwen2.5', 'deepseek-r1', 'phi3', 'gemma2', 'llama3.1', 'llava']
            },
            live_ollama_detected: false
        };
    }

    function updateHints() {
        const provider = getSelectedProvider();
        const model = getSelectedModel();
        const hintEl = document.getElementById('aiModelHint');
        const keyInput = findKeyInput();

        if (hintEl) {
            if (provider === 'ollama') {
                hintEl.innerHTML = '🦙 <strong>Ollama Local:</strong> Model <code>' + model + '</code> runs on-device. No cloud API key needed.';
                hintEl.style.color = '#7df0a0';
            } else if (provider === 'opencode-go') {
                hintEl.innerHTML = '⚡ <strong>OpenCode Go:</strong> Fast cloud multimodal inference (<code>' + model + '</code>).';
                hintEl.style.color = '#7df0ef';
            } else {
                hintEl.innerHTML = '✨ <strong>Google Gemini:</strong> Official Gemini API (<code>' + model + '</code>). Requires Gemini API key.';
                hintEl.style.color = '#ffd070';
            }
        }

        if (keyInput) {
            if (provider === 'ollama') {
                keyInput.placeholder = 'Local Ollama Model (No API Key Required)';
            } else if (provider === 'opencode-go') {
                keyInput.placeholder = 'OpenCode Go API Key (or leave default)';
                if (!keyInput.value) keyInput.value = DEFAULT_OPENCODE_KEY;
            } else {
                keyInput.placeholder = 'Enter Google Gemini API Key...';
                if (keyInput.value === DEFAULT_OPENCODE_KEY) keyInput.value = '';
            }
        }
    }

    function ensureModelSelectorUI() {
        let selects = findModelSelects();
        if (selects.length > 0) return selects[0];

        const keyInput = findKeyInput();
        if (!keyInput) return null;

        const parent = keyInput.closest('.form-group') || keyInput.parentNode;
        if (!parent) return null;

        const container = document.createElement('div');
        container.className = 'form-group ai-model-selector-container';
        container.style.cssText = 'margin-bottom: 12px;';
        container.innerHTML = `
            <label class="form-label" style="display:block; font-size:0.78rem; font-weight:bold; color:var(--accent-cyan, #00f0ff); margin-bottom:4px;">
                🤖 AI Model (OpenCode Go, Gemini, Ollama)
            </label>
            <select id="selectModel" class="form-select select" style="width:100%; background:var(--input-bg, #16242e); color:var(--text-primary, #e0f0f5); border:1px solid var(--border-color, #2a4454); padding:6px 10px; border-radius:6px; font-size:0.8rem; cursor:pointer;">
            </select>
            <div id="aiModelHint" style="font-size:0.72rem; color:var(--text-muted, #8ab); margin-top:4px;"></div>
        `;

        parent.parentNode.insertBefore(container, parent);
        return document.getElementById('selectModel');
    }

    async function populateSelectors() {
        const data = await fetchModels();
        ensureModelSelectorUI();
        const selects = findModelSelects();
        if (!selects.length) return;

        const savedModel = getSelectedModel();
        const savedProvider = getSelectedProvider();
        const compoundTarget = savedProvider + ':' + savedModel;

        selects.forEach(function (select) {
            select.innerHTML = '';

            // 1. OpenCode Go Group
            const goGroup = document.createElement('optgroup');
            goGroup.label = '⚡ OpenCode Go (Cloud Models)';
            (data.models['opencode-go'] || []).forEach(function (m) {
                const opt = document.createElement('option');
                opt.value = 'opencode-go:' + m;
                opt.textContent = '⚡ ' + m + (m === 'gemini-4-argon' ? ' (Default)' : '');
                if (opt.value === compoundTarget || (savedProvider === 'opencode-go' && savedModel === m)) {
                    opt.selected = true;
                }
                goGroup.appendChild(opt);
            });
            select.appendChild(goGroup);

            // 2. Google Gemini Group
            const geminiGroup = document.createElement('optgroup');
            geminiGroup.label = '✨ Google Gemini (AI Studio)';
            (data.models['google'] || []).forEach(function (m) {
                const opt = document.createElement('option');
                opt.value = 'google:' + m;
                opt.textContent = '✨ ' + m + (m === 'gemini-3.8-flash' ? ' (Fast Multimodal)' : '');
                if (opt.value === compoundTarget || (savedProvider === 'google' && savedModel === m)) {
                    opt.selected = true;
                }
                geminiGroup.appendChild(opt);
            });
            select.appendChild(geminiGroup);

            // 3. Ollama Local Group
            const ollamaGroup = document.createElement('optgroup');
            ollamaGroup.label = data.live_ollama_detected
                ? '🦙 Ollama Local Models (🟢 Live Server Detected)'
                : '🦙 Ollama Local Models (On-Device Local AI)';
            (data.models['ollama'] || []).forEach(function (m) {
                const opt = document.createElement('option');
                opt.value = 'ollama:' + m;
                opt.textContent = '🦙 ' + m + ' (Local)';
                if (opt.value === compoundTarget || (savedProvider === 'ollama' && savedModel === m)) {
                    opt.selected = true;
                }
                ollamaGroup.appendChild(opt);
            });
            select.appendChild(ollamaGroup);

            select.addEventListener('change', function () {
                const val = select.value || '';
                if (val.indexOf(':') !== -1) {
                    const parts = val.split(':');
                    setSelected(parts[0], parts[1]);
                } else {
                    setSelected('', val);
                }
                // Sync other selects
                selects.forEach(function (other) {
                    if (other !== select) other.value = val;
                });
            });
        });

        updateHints();
    }

    // Intercept fetch calls to /api/gemini/chat and /api/gemini/voice
    const origFetch = window.fetch;
    window.fetch = function (resource, options) {
        if (typeof resource === 'string' &&
            (resource.indexOf('/api/gemini/chat') !== -1 || resource.indexOf('/api/gemini/voice') !== -1) &&
            options && options.body && typeof options.body === 'string') {
            try {
                const payload = JSON.parse(options.body);
                const provider = getSelectedProvider();
                const model = getSelectedModel();

                payload.provider = provider;
                payload.model = model;

                if (provider === 'opencode-go' && !payload.api_key) {
                    payload.api_key = DEFAULT_OPENCODE_KEY;
                }
                options.body = JSON.stringify(payload);
            } catch (e) {}
        }
        return origFetch.apply(this, arguments);
    };

    function init() {
        populateSelectors();
        [400, 1200, 2500].forEach(function (d) {
            setTimeout(populateSelectors, d);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.AiModelSelector = {
        getModel: getSelectedModel,
        getProvider: getSelectedProvider,
        setModel: setSelected,
        refresh: populateSelectors
    };
})();
