const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('openclawRuntime', {
    getStatus: () => ipcRenderer.invoke('openclaw-runtime:get-status'),
    start: () => ipcRenderer.invoke('openclaw-runtime:start'),
    configureProvider: (payload) => ipcRenderer.invoke('openclaw-runtime:configure-provider', payload),
    restart: () => ipcRenderer.invoke('openclaw-runtime:restart'),
    stop: () => ipcRenderer.invoke('openclaw-runtime:stop'),
    openHome: () => ipcRenderer.invoke('openclaw-runtime:open-home'),
    openLogs: () => ipcRenderer.invoke('openclaw-runtime:open-logs'),
    onStatus: (listener) => {
        const wrapped = (_event, payload = {}) => listener(payload);
        ipcRenderer.on('openclaw-runtime:status', wrapped);
        return () => ipcRenderer.removeListener('openclaw-runtime:status', wrapped);
    }
});
