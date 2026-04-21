const path = require('path');
const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const { OpenClawRuntimeSupervisor } = require('./supervisor.cjs');

const RUNTIME_APP_NAME = 'OpenClaw Runtime';

let mainWindow = null;
let supervisor = null;

app.setName(RUNTIME_APP_NAME);

function configureAppPaths() {
    const userDataDir = path.join(app.getPath('appData'), RUNTIME_APP_NAME);
    const logsDir = path.join(userDataDir, 'logs');

    app.setPath('userData', userDataDir);
    app.setAppLogsPath(logsDir);
    app.setPath('logs', logsDir);
    app.setAppUserModelId('com.openclaw.runtime');
}

configureAppPaths();

function getUserDataDir() {
    return app.getPath('userData');
}

function getLogsDir() {
    return app.getPath('logs');
}

function ensureSupervisor() {
    if (supervisor) {
        return supervisor;
    }

    supervisor = new OpenClawRuntimeSupervisor({
        app,
        userDataDir: getUserDataDir(),
        logsDir: getLogsDir()
    });

    supervisor.on('status', (status) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('openclaw-runtime:status', status);
        }
    });

    return supervisor;
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1360,
        height: 940,
        minWidth: 1120,
        minHeight: 780,
        show: false,
        title: 'OpenClaw Runtime',
        backgroundColor: '#0d1620',
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });

    Menu.setApplicationMenu(null);

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        void shell.openExternal(url);
        return { action: 'deny' };
    });

    void mainWindow.loadFile(path.join(__dirname, 'index.html')).then(() => {
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send('openclaw-runtime:status', ensureSupervisor().getStatus());
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

function registerIpc() {
    ipcMain.handle('openclaw-runtime:get-status', () => ensureSupervisor().getStatus());
    ipcMain.handle('openclaw-runtime:start', async () => {
        return await ensureSupervisor().ensureReady();
    });
    ipcMain.handle('openclaw-runtime:configure-provider', async (_event, payload = {}) => {
        return await ensureSupervisor().configureProvider(payload);
    });
    ipcMain.handle('openclaw-runtime:restart', async () => {
        const runtime = ensureSupervisor();
        await runtime.shutdown();
        return await runtime.ensureReady();
    });
    ipcMain.handle('openclaw-runtime:stop', async () => {
        return await ensureSupervisor().shutdown();
    });
    ipcMain.handle('openclaw-runtime:open-home', async () => {
        await shell.openPath(ensureSupervisor().getStatus().openClawHome);
        return true;
    });
    ipcMain.handle('openclaw-runtime:open-logs', async () => {
        await shell.openPath(ensureSupervisor().getStatus().logsDir);
        return true;
    });
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) {
                mainWindow.restore();
            }
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

app.whenReady().then(async () => {
    registerIpc();
    createWindow();

    try {
        await ensureSupervisor().ensureReady();
    } catch (error) {
        console.warn('⚠️ OpenClaw runtime 首启失败：', error);
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        } else if (mainWindow) {
            mainWindow.show();
        }
    });
});

app.on('before-quit', () => {
    void supervisor?.shutdown();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
