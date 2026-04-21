const { contextBridge, ipcRenderer } = require('electron');

const runtimeConfig = {
    backendMode:
        process.env.HUMANCLAW_BACKEND_MODE ||
        process.env.AIGRIL_BACKEND_MODE ||
        'companion-service',
    backendBaseUrl:
        process.env.HUMANCLAW_BACKEND_BASE_URL ||
        process.env.AIGRIL_BACKEND_BASE_URL ||
        process.env.BACKEND_BASE_URL ||
        '',
    openclawGatewayUrl:
        process.env.HUMANCLAW_OPENCLAW_GATEWAY_URL ||
        process.env.AIGRIL_OPENCLAW_GATEWAY_URL ||
        '',
    voiceInputEnabled:
        process.env.HUMANCLAW_VOICE_INPUT_ENABLED !== 'false',
    voiceOutputEnabled:
        process.env.HUMANCLAW_VOICE_OUTPUT_ENABLED !== 'false',
    recognitionMode:
        process.env.HUMANCLAW_RECOGNITION_MODE ||
        'manual',
    preferredMicDeviceId:
        process.env.HUMANCLAW_PREFERRED_MIC_DEVICE_ID ||
        '',
    cameraDistance: Number(process.env.HUMANCLAW_CAMERA_DISTANCE || 1.1),
    cameraTargetY: Number(process.env.HUMANCLAW_CAMERA_TARGET_Y || 1.0),
    assistantReady: process.env.HUMANCLAW_ASSISTANT_READY === 'true',
    assistantEffectiveMode: process.env.HUMANCLAW_ASSISTANT_EFFECTIVE_MODE || 'backend',
    assistantReason: process.env.HUMANCLAW_ASSISTANT_REASON || ''
};

const initialPreferences = {
    ...runtimeConfig
};

contextBridge.exposeInMainWorld('aigrilDesktop', {
    platform: 'electron',
    preferences: initialPreferences,
    versions: {
        chrome: process.versions.chrome,
        electron: process.versions.electron,
        node: process.versions.node
    },
    runtimeConfig,
    toggleChatWindow: () => ipcRenderer.invoke('aigril:toggle-chat-window'),
    showChatWindow: () => ipcRenderer.invoke('aigril:show-chat-window'),
    hideChatWindow: () => ipcRenderer.invoke('aigril:hide-chat-window'),
    showControlWindow: () => ipcRenderer.invoke('aigril:show-control-window'),
    showSetupWindow: () => ipcRenderer.invoke('aigril:show-setup-window'),
    showControlPanel: () => ipcRenderer.invoke('aigril:show-control-window'),
    showPetContextMenu: () => ipcRenderer.invoke('aigril:show-pet-context-menu'),
    showControlMenu: () => ipcRenderer.invoke('aigril:show-pet-context-menu'),
    getRuntimeSettings: () => ipcRenderer.invoke('aigril:get-runtime-settings'),
    saveRuntimeSettings: (patch) => ipcRenderer.invoke('aigril:save-runtime-settings', patch || {}),
    savePreferences: (patch) => ipcRenderer.invoke('aigril:save-runtime-settings', patch || {}),
    setRecognitionMode: (mode) => ipcRenderer.invoke('aigril:set-recognition-mode', mode),
    setPreferredMicDevice: (deviceId) => ipcRenderer.invoke('aigril:set-preferred-mic-device', deviceId),
    completeOnboarding: (payload) => ipcRenderer.invoke('aigril:complete-onboarding', payload || {}),
    runRuntimeHealthCheck: () => ipcRenderer.invoke('aigril:run-runtime-health-check'),
    closeCurrentWindow: () => ipcRenderer.invoke('aigril:close-current-window'),
    dragPetWindow: (deltaX, deltaY) => {
        ipcRenderer.send('aigril:drag-pet-window', { deltaX, deltaY });
    },
    sendChatMessage: (content) => {
        ipcRenderer.send('aigril:chat-send-message', { content });
    },
    emitChatEvent: (payload) => {
        ipcRenderer.send('aigril:pet-chat-event', payload || {});
    },
    requestChatStateSync: () => {
        ipcRenderer.send('aigril:chat-state-sync-request');
    },
    transcribeAudio: (audioBytes) => ipcRenderer.invoke('aigril:asr-transcribe', audioBytes),
    onChatMessageRequest: (listener) => {
        const wrapped = (_event, payload = {}) => listener(payload);
        ipcRenderer.on('aigril:chat-send-message', wrapped);
        return () => ipcRenderer.removeListener('aigril:chat-send-message', wrapped);
    },
    onChatStateSyncRequest: (listener) => {
        const wrapped = (_event, payload = {}) => listener(payload);
        ipcRenderer.on('aigril:chat-state-sync-request', wrapped);
        return () => ipcRenderer.removeListener('aigril:chat-state-sync-request', wrapped);
    },
    onChatEvent: (listener) => {
        const wrapped = (_event, payload = {}) => listener(payload);
        ipcRenderer.on('aigril:chat-event', wrapped);
        return () => ipcRenderer.removeListener('aigril:chat-event', wrapped);
    },
    onPetWindowState: (listener) => {
        const wrapped = (_event, payload = {}) => listener(payload);
        ipcRenderer.on('aigril:pet-window-state', wrapped);
        return () => ipcRenderer.removeListener('aigril:pet-window-state', wrapped);
    },
    onSettingsUpdate: (listener) => {
        const wrapped = (_event, payload = {}) => listener(payload);
        ipcRenderer.on('aigril:settings-updated', wrapped);
        return () => ipcRenderer.removeListener('aigril:settings-updated', wrapped);
    },
    onPreferencesUpdated: (listener) => {
        const wrapped = (_event, payload = {}) => {
            if (payload && typeof payload === 'object') {
                Object.assign(initialPreferences, payload);
            }
            listener({
                preferences: initialPreferences
            });
        };
        ipcRenderer.on('aigril:settings-updated', wrapped);
        return () => ipcRenderer.removeListener('aigril:settings-updated', wrapped);
    },
    assistant: {
        isSupported: true,
        getStatus: () => ipcRenderer.invoke('aigril:assistant-status'),
        getHistory: (limit) => ipcRenderer.invoke('aigril:assistant-history', { limit }),
        sendMessage: (content, timeoutMs) =>
            ipcRenderer.invoke('aigril:assistant-send-message', { content, timeoutMs }),
        abortRun: (runId) => ipcRenderer.invoke('aigril:assistant-abort-run', { runId }),
        listSessions: (limit) => ipcRenderer.invoke('aigril:assistant-list-sessions', { limit }),
        setSessionKey: (sessionKey) =>
            ipcRenderer.invoke('aigril:assistant-set-session-key', { sessionKey }),
        patchSession: (patch) => ipcRenderer.invoke('aigril:assistant-patch-session', patch || {}),
        onEvent: (listener) => {
            const wrapped = (_event, payload = {}) => listener(payload);
            ipcRenderer.on('aigril:assistant-event', wrapped);
            return () => ipcRenderer.removeListener('aigril:assistant-event', wrapped);
        }
    }
});
