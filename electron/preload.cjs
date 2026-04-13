const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aigrilDesktop', {
    platform: 'electron',
    versions: {
        chrome: process.versions.chrome,
        electron: process.versions.electron,
        node: process.versions.node
    },
    toggleChatWindow: () => ipcRenderer.invoke('aigril:toggle-chat-window'),
    showChatWindow: () => ipcRenderer.invoke('aigril:show-chat-window'),
    hideChatWindow: () => ipcRenderer.invoke('aigril:hide-chat-window'),
    showPetContextMenu: () => ipcRenderer.invoke('aigril:show-pet-context-menu'),
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
