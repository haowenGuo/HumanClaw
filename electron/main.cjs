const path = require('path');
const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, session, shell } = require('electron');
const { getBundledInstallEdition } = require('./app-edition.cjs');
const {
    applyRuntimeEnvironment,
    ensureHumanClawFsLayout,
    resolveHumanClawFsLayout
} = require('./fs-layout.cjs');
const { OpenClawGatewayManager } = require('./openclaw-gateway.cjs');
const { DesktopASRManager } = require('./local-asr-manager.cjs');
const {
    DEFAULT_PET_SCALE,
    PET_SCALE_OPTIONS,
    getScaledPetSize,
    loadDesktopState,
    normalizePreferredMicDeviceId,
    normalizePetScale,
    normalizeRecognitionMode,
    resizePetBounds,
    saveDesktopState
} = require('./store.cjs');

const DEFAULT_DEV_SERVER_URL = 'http://127.0.0.1:5173';
const devServerUrl = process.env.AIGRIL_DESKTOP_DEV_URL || '';
const PET_MIN_SIZE = getScaledPetSize(PET_SCALE_OPTIONS[0]);
const CHAT_MIN_WIDTH = 360;
const CHAT_MIN_HEIGHT = 420;
const CONTROL_MIN_WIDTH = 860;
const CONTROL_MIN_HEIGHT = 620;
const SETUP_MIN_WIDTH = 880;
const SETUP_MIN_HEIGHT = 640;
const bundledInstallEdition = getBundledInstallEdition(app);
const runtimeLayout = resolveHumanClawFsLayout({
    installEdition: bundledInstallEdition
});

ensureHumanClawFsLayout(runtimeLayout);
applyRuntimeEnvironment(runtimeLayout);
app.setPath('appData', runtimeLayout.runtimeRoot);
app.setPath('userData', runtimeLayout.userDataDir);
app.setPath('sessionData', runtimeLayout.sessionDataDir);
app.setPath('logs', runtimeLayout.logsDir);
app.setPath('temp', runtimeLayout.tempDir);
app.setPath('crashDumps', runtimeLayout.crashDumpsDir);
if (typeof app.setAppLogsPath === 'function') {
    app.setAppLogsPath(runtimeLayout.logsDir);
}
app.commandLine.appendSwitch('disk-cache-dir', runtimeLayout.cacheDir);

let petWindow = null;
let chatWindow = null;
let controlWindow = null;
let setupWindow = null;
let tray = null;
let isQuitting = false;
let desktopState = null;
let assistantGateway = null;
let desktopASRManager = null;
let assistantHealthState = null;
const windowPersistTimers = new Map();

function configureMediaPermissions() {
    const defaultSession = session.defaultSession;
    if (!defaultSession) {
        return;
    }

    defaultSession.setPermissionCheckHandler((_webContents, permission) => (
        permission === 'media' || permission === 'audioCapture'
    ));

    defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
        if (permission === 'media' || permission === 'audioCapture') {
            callback(true);
            return;
        }
        callback(false);
    });
}

function isDevMode() {
    return Boolean(devServerUrl);
}

function buildRendererUrl(pageName) {
    if (isDevMode()) {
        return `${devServerUrl || DEFAULT_DEV_SERVER_URL}/${pageName}`;
    }
    return path.join(__dirname, '..', 'dist', pageName);
}

function normalizeOptionalString(value, fallback = '') {
    if (typeof value !== 'string') {
        return fallback;
    }
    const trimmed = value.trim();
    return trimmed || fallback;
}

function getCurrentPreferences() {
    return desktopState?.preferences || {};
}

function normalizeBackendMode(value, fallback = 'companion-service') {
    const normalized = normalizeOptionalString(value, '').toLowerCase();
    if (normalized === 'companion-service' || normalized === 'openclaw-local') {
        return normalized;
    }
    if (normalized === 'openclaw' || normalized === 'aigril') {
        return 'openclaw-local';
    }
    if (normalized === 'companion') {
        return 'companion-service';
    }
    if (normalized === 'assistant' || normalized === 'operator') {
        return 'openclaw-local';
    }
    return fallback;
}

function shouldUseOpenClaw(settings = buildRuntimeSettingsCore()) {
    return normalizeBackendMode(settings.backendMode) === 'openclaw-local';
}

function buildRuntimeSettingsCore() {
    const preferences = getCurrentPreferences();
    return {
        backendMode: normalizeBackendMode(preferences.backendMode || preferences.installEdition),
        onboardingCompleted: Boolean(preferences.onboardingCompleted),
        autoLaunchOnLogin: Boolean(preferences.autoLaunchOnLogin),
        petScale: Number(preferences.petScale) || DEFAULT_PET_SCALE,
        petSkipTaskbar: Boolean(preferences.petSkipTaskbar),
        cameraDistance: Number(preferences.cameraDistance) || 1.1,
        cameraTargetY: Number(preferences.cameraTargetY) || 1.0,
        backendBaseUrl: normalizeOptionalString(preferences.backendBaseUrl, 'https://airi-backend.onrender.com'),
        openclawGatewayUrl: normalizeOptionalString(preferences.openclawGatewayUrl, 'ws://127.0.0.1:19011'),
        voiceInputEnabled: preferences.voiceInputEnabled !== false,
        voiceOutputEnabled: preferences.voiceOutputEnabled !== false,
        recognitionMode: normalizeRecognitionMode(preferences.recognitionMode),
        preferredMicDeviceId: normalizePreferredMicDeviceId(preferences.preferredMicDeviceId)
    };
}

function buildAssistantHealthSnapshot(settings = buildRuntimeSettingsCore(), overrides = {}) {
    const backendMode = normalizeBackendMode(settings.backendMode);
    const gatewayStatus = overrides.gatewayStatus || assistantGateway?.getStatus?.() || {
        enabled: backendMode === 'openclaw-local',
        connected: false,
        connecting: false,
        gatewayUrl: settings.openclawGatewayUrl,
        lastError: ''
    };
    const probeError = normalizeOptionalString(overrides.probeError);

    if (backendMode === 'companion-service') {
        return {
            status: 'service',
            ready: false,
            effectiveMode: 'backend',
            reason: `当前对话走陪伴后端：${settings.backendBaseUrl}`,
            hint: '如果你已经自行安装并启动 OpenClaw，可切到“本地 OpenClaw”后再做健康检查。',
            gatewayUrl: gatewayStatus.gatewayUrl || settings.openclawGatewayUrl,
            checkedAt: Date.now()
        };
    }

    if (gatewayStatus.connected) {
        return {
            status: 'ready',
            ready: true,
            effectiveMode: 'assistant',
            reason: `已连接用户本地 OpenClaw Gateway：${gatewayStatus.gatewayUrl || settings.openclawGatewayUrl}`,
            hint: '当前桌宠会把对话转发给 OpenClaw，由它自己维护 session、工具和任务运行。',
            gatewayUrl: gatewayStatus.gatewayUrl || settings.openclawGatewayUrl,
            checkedAt: Date.now()
        };
    }

    if (gatewayStatus.connecting) {
        return {
            status: 'checking',
            ready: false,
            effectiveMode: 'backend',
            reason: `${gatewayStatus.gatewayUrl || settings.openclawGatewayUrl} 正在连接中。`,
            hint: '如果长时间停在这里，通常是本机 OpenClaw 还没启动，或者 Gateway 地址写错了。',
            gatewayUrl: gatewayStatus.gatewayUrl || settings.openclawGatewayUrl,
            checkedAt: Date.now()
        };
    }

    return {
        status: 'degraded',
        ready: false,
        effectiveMode: 'backend',
        reason:
            probeError ||
            normalizeOptionalString(gatewayStatus.lastError) ||
            `未检测到可用的用户本地 OpenClaw Gateway：${gatewayStatus.gatewayUrl || settings.openclawGatewayUrl}`,
        hint: '请先在本机自行安装并启动 OpenClaw，并在 OpenClaw 侧完成 provider、模型和权限配置。HumanClaw 只负责连接，不负责部署和修复。',
        gatewayUrl: gatewayStatus.gatewayUrl || settings.openclawGatewayUrl,
        checkedAt: Date.now()
    };
}

function buildRuntimeSettingsPayload() {
    const settings = buildRuntimeSettingsCore();
    return {
        ...settings,
        assistantHealth: assistantHealthState || buildAssistantHealthSnapshot(settings)
    };
}

async function refreshAssistantHealth(options = {}) {
    const { probe = false } = options;
    const settings = buildRuntimeSettingsCore();
    let probeError = '';
    let gatewayStatus = assistantGateway?.getStatus?.() || {
        enabled: shouldUseOpenClaw(settings),
        connected: false,
        connecting: false,
        gatewayUrl: settings.openclawGatewayUrl,
        lastError: ''
    };

    if (probe && shouldUseOpenClaw(settings)) {
        try {
            const gateway = ensureAssistantGateway();
            await gateway.ensureConnected();
            gatewayStatus = gateway.getStatus();
        } catch (error) {
            if (!probeError) {
                probeError = error instanceof Error ? error.message : String(error);
            }
            gatewayStatus = assistantGateway?.getStatus?.() || gatewayStatus;
        }
    }

    assistantHealthState = buildAssistantHealthSnapshot(settings, {
        gatewayStatus,
        probeError
    });
    syncRuntimeEnvironment();
    broadcastSettingsUpdate();
    return assistantHealthState;
}

function syncRuntimeEnvironment() {
    const settings = buildRuntimeSettingsPayload();
    process.env.HUMANCLAW_BACKEND_MODE = settings.backendMode;
    process.env.AIGRIL_BACKEND_MODE = settings.backendMode;
    process.env.HUMANCLAW_BACKEND_BASE_URL = settings.backendBaseUrl;
    process.env.AIGRIL_BACKEND_BASE_URL = settings.backendBaseUrl;
    process.env.HUMANCLAW_OPENCLAW_GATEWAY_URL = settings.openclawGatewayUrl;
    process.env.AIGRIL_OPENCLAW_GATEWAY_URL = settings.openclawGatewayUrl;
    process.env.HUMANCLAW_VOICE_INPUT_ENABLED = String(settings.voiceInputEnabled);
    process.env.HUMANCLAW_VOICE_OUTPUT_ENABLED = String(settings.voiceOutputEnabled);
    process.env.HUMANCLAW_RECOGNITION_MODE = settings.recognitionMode;
    process.env.HUMANCLAW_PREFERRED_MIC_DEVICE_ID = settings.preferredMicDeviceId;
    process.env.HUMANCLAW_CAMERA_DISTANCE = String(settings.cameraDistance);
    process.env.HUMANCLAW_CAMERA_TARGET_Y = String(settings.cameraTargetY);
    process.env.HUMANCLAW_ASSISTANT_READY = String(Boolean(settings.assistantHealth?.ready));
    process.env.HUMANCLAW_ASSISTANT_EFFECTIVE_MODE = normalizeOptionalString(
        settings.assistantHealth?.effectiveMode,
        'backend'
    );
    process.env.HUMANCLAW_ASSISTANT_REASON = normalizeOptionalString(settings.assistantHealth?.reason);
}

function applyLoginPreference() {
    const settings = buildRuntimeSettingsPayload();
    app.setLoginItemSettings({
        openAtLogin: Boolean(settings.autoLaunchOnLogin),
        path: process.execPath
    });
}

function getOpenWindows() {
    return [petWindow, chatWindow, controlWindow, setupWindow].filter(
        (window) => window && !window.isDestroyed()
    );
}

function broadcastSettingsUpdate() {
    const payload = buildRuntimeSettingsPayload();
    for (const window of getOpenWindows()) {
        window.webContents.send('aigril:settings-updated', payload);
    }
}

async function handleAsrTranscribeRequest(payload = {}) {
    if (!buildRuntimeSettingsPayload().voiceInputEnabled) {
        throw new Error('当前版本已关闭本地语音识别');
    }
    if (!desktopASRManager) {
        throw new Error('桌宠本地语音识别尚未初始化');
    }

    const audioBytes = payload?.audioBytes ? payload.audioBytes : payload;
    return desktopASRManager.transcribeAudioBytes(audioBytes);
}

function makeTrayIcon() {
    const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">
            <rect width="64" height="64" rx="14" fill="#73b8e5"/>
            <text x="50%" y="58%" text-anchor="middle" font-size="28" font-family="Segoe UI, Arial" fill="#ffffff">AG</text>
        </svg>
    `;

    return nativeImage
        .createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
        .resize({ width: 16, height: 16 });
}

function clampBoundsToDisplay(bounds, minimumWidth = 320, minimumHeight = 320) {
    const display = screen.getDisplayMatching(bounds);
    const workArea = display.workArea;
    const width = Math.min(Math.max(bounds.width, minimumWidth), workArea.width);
    const height = Math.min(Math.max(bounds.height, minimumHeight), workArea.height);

    return {
        ...bounds,
        width,
        height,
        x: Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width),
        y: Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height)
    };
}

function persistDesktopState() {
    desktopState = saveDesktopState(app, desktopState);
    refreshTrayMenu();
}

function resizePetWindowForScale(scale) {
    const normalizedScale = normalizePetScale(scale);
    const referenceBounds = petWindow ? petWindow.getBounds() : desktopState.petWindow.bounds;
    const nextBounds = clampBoundsToDisplay(
        resizePetBounds(referenceBounds, normalizedScale),
        PET_MIN_SIZE.width,
        PET_MIN_SIZE.height
    );

    desktopState.preferences.petScale = normalizedScale;
    desktopState.petWindow.bounds = nextBounds;

    if (petWindow) {
        petWindow.setBounds(nextBounds);
    }
}

function applyWindowLevelPreferences() {
    if (petWindow) {
        petWindow.setSkipTaskbar(Boolean(desktopState.preferences.petSkipTaskbar));
    }
}

async function reconnectAssistantGateway() {
    if (assistantGateway) {
        await assistantGateway.shutdown().catch(() => {});
        assistantGateway = null;
    }

    const gateway = ensureAssistantGateway();
    broadcastAssistantEvent({
        type: 'status',
        payload: gateway.getStatus()
    });

    if (gateway.getStatus().enabled) {
        await gateway.ensureConnected().catch(() => {});
    }

    await refreshAssistantHealth({ probe: false }).catch(() => {});
}

function resetAssistantGateway() {
    void reconnectAssistantGateway();
}

function updateDesktopPreferences(patch = {}, options = {}) {
    if (!desktopState) {
        return buildRuntimeSettingsPayload();
    }

    const currentPreferences = getCurrentPreferences();
    const patchWithoutProvider = {
        ...(patch || {})
    };
    delete patchWithoutProvider.assistantProvider;
    delete patchWithoutProvider.featureGrants;

    const nextBackendMode = normalizeBackendMode(
        patchWithoutProvider.backendMode || patchWithoutProvider.installEdition || currentPreferences.backendMode
    );
    delete patchWithoutProvider.installEdition;

    const nextPreferences = {
        ...currentPreferences,
        ...patchWithoutProvider,
        backendMode: nextBackendMode,
        installEdition: nextBackendMode === 'companion-service' ? 'companion' : 'assistant'
    };

    nextPreferences.recognitionMode = normalizeRecognitionMode(nextPreferences.recognitionMode);
    nextPreferences.preferredMicDeviceId = normalizePreferredMicDeviceId(
        nextPreferences.preferredMicDeviceId
    );

    desktopState.preferences = nextPreferences;

    if (Object.prototype.hasOwnProperty.call(patchWithoutProvider, 'petScale')) {
        resizePetWindowForScale(nextPreferences.petScale);
    }

    applyWindowLevelPreferences();
    assistantHealthState = buildAssistantHealthSnapshot(buildRuntimeSettingsCore());
    syncRuntimeEnvironment();
    applyLoginPreference();
    persistDesktopState();
    broadcastSettingsUpdate();

    const shouldRefreshAssistantHealth =
        options.resetAssistantGateway ||
        Object.prototype.hasOwnProperty.call(patchWithoutProvider, 'backendMode') ||
        Object.prototype.hasOwnProperty.call(patch, 'installEdition') ||
        Object.prototype.hasOwnProperty.call(patchWithoutProvider, 'openclawGatewayUrl');

    if (
        options.resetAssistantGateway ||
        Object.prototype.hasOwnProperty.call(patchWithoutProvider, 'backendMode') ||
        Object.prototype.hasOwnProperty.call(patch, 'installEdition') ||
        Object.prototype.hasOwnProperty.call(patchWithoutProvider, 'openclawGatewayUrl')
    ) {
        resetAssistantGateway();
    }

    if (shouldRefreshAssistantHealth) {
        void refreshAssistantHealth({ probe: true }).catch(() => {});
    }

    return buildRuntimeSettingsPayload();
}

function updateWindowState(key, window, options = {}) {
    if (!window || !desktopState?.[key]) {
        return;
    }

    const minimumWidth = key === 'petWindow' ? PET_MIN_SIZE.width : CHAT_MIN_WIDTH;
    const minimumHeight = key === 'petWindow' ? PET_MIN_SIZE.height : CHAT_MIN_HEIGHT;

    desktopState[key].bounds = clampBoundsToDisplay(
        window.getBounds(),
        minimumWidth,
        minimumHeight
    );
    desktopState[key].visible = window.isVisible();

    if (options.immediate) {
        persistDesktopState();
        return;
    }

    clearTimeout(windowPersistTimers.get(key));
    windowPersistTimers.set(key, setTimeout(() => {
        persistDesktopState();
        windowPersistTimers.delete(key);
    }, 120));
}

function hookWindowPersistence(key, window) {
    window.on('move', () => updateWindowState(key, window));
    window.on('resize', () => updateWindowState(key, window));
    window.on('show', () => updateWindowState(key, window, { immediate: true }));
    window.on('hide', () => updateWindowState(key, window, { immediate: true }));
    window.on('closed', () => {
        clearTimeout(windowPersistTimers.get(key));
        windowPersistTimers.delete(key);
    });
}

function openExternalLinks(window) {
    window.webContents.setWindowOpenHandler(({ url }) => {
        void shell.openExternal(url);
        return { action: 'deny' };
    });
}

function loadWindowContent(window, pageName) {
    if (isDevMode()) {
        return window.loadURL(buildRendererUrl(pageName));
    }
    return window.loadFile(buildRendererUrl(pageName));
}

function sendPetWindowState() {
    if (!petWindow || petWindow.isDestroyed() || petWindow.webContents.isDestroyed()) {
        return;
    }

    petWindow.webContents.send('aigril:pet-window-state', {
        visible: petWindow.isVisible(),
        focused: petWindow.isFocused()
    });
}

function broadcastAssistantEvent(payload) {
    if (!payload) {
        return;
    }
    for (const window of getOpenWindows()) {
        window.webContents.send('aigril:assistant-event', payload);
    }
}

function ensureAssistantGateway() {
    if (assistantGateway) {
        return assistantGateway;
    }

    const settings = buildRuntimeSettingsPayload();
    assistantGateway = new OpenClawGatewayManager({
        clientVersion: app.getVersion(),
        enabled: settings.backendMode === 'openclaw-local',
        gatewayUrl: settings.openclawGatewayUrl
    });

    assistantGateway.on('status', (status) => {
        broadcastAssistantEvent({
            type: 'status',
            payload: status
        });
    });

    assistantGateway.on('event', (event) => {
        broadcastAssistantEvent(event);
    });

    return assistantGateway;
}

function showChatWindow() {
    if (!chatWindow) {
        createChatWindow();
    }

    if (!chatWindow.isVisible()) {
        chatWindow.show();
    }

    chatWindow.focus();
}

function hideChatWindow() {
    if (chatWindow?.isVisible()) {
        chatWindow.hide();
    }
}

function showControlWindow() {
    if (!controlWindow) {
        createControlWindow();
    }

    if (!controlWindow.isVisible()) {
        controlWindow.show();
    }

    controlWindow.focus();
}

function hideControlWindow() {
    if (controlWindow?.isVisible()) {
        controlWindow.hide();
    }
}

function showSetupWindow() {
    if (!setupWindow) {
        createSetupWindow();
    }

    if (!setupWindow.isVisible()) {
        setupWindow.show();
    }

    setupWindow.focus();
}

function hideSetupWindow() {
    if (setupWindow?.isVisible()) {
        setupWindow.hide();
    }
}

function toggleChatWindow() {
    if (!chatWindow || !chatWindow.isVisible()) {
        showChatWindow();
        return true;
    }

    hideChatWindow();
    return false;
}

function quitApplication() {
    isQuitting = true;
    app.quit();
}

function applyPetScale(scale) {
    if (!desktopState) {
        return;
    }
    updateDesktopPreferences({ petScale: scale });
    if (petWindow) {
        petWindow.show();
        petWindow.focus();
    }
}

function buildPetScaleMenu() {
    const currentScale = normalizePetScale(desktopState?.preferences?.petScale || DEFAULT_PET_SCALE);

    return PET_SCALE_OPTIONS.map((scale) => ({
        label: `${Math.round(scale * 100)}%`,
        type: 'radio',
        checked: currentScale === scale,
        click: () => applyPetScale(scale)
    }));
}

function buildPetContextMenu() {
    const settings = buildRuntimeSettingsPayload();
    const backendLabelMap = {
        'companion-service': '陪伴后端',
        'openclaw-local': '本地 OpenClaw'
    };

    return Menu.buildFromTemplate([
        {
            label: '聊天',
            click: () => showChatWindow()
        },
        {
            label: '控制面板',
            click: () => showControlWindow()
        },
        {
            label: '首启向导',
            click: () => showSetupWindow()
        },
        {
            label: '缩放',
            submenu: buildPetScaleMenu()
        },
        {
            label: `当前后端：${backendLabelMap[settings.backendMode] || '陪伴后端'}`,
            enabled: false
        },
        { type: 'separator' },
        {
            label: '退出',
            click: () => quitApplication()
        }
    ]);
}

function showPetContextMenu() {
    if (!petWindow) {
        return false;
    }

    buildPetContextMenu().popup({ window: petWindow });
    return true;
}

function createPetWindow() {
    const petState = desktopState.petWindow;
    const petBounds = clampBoundsToDisplay(petState.bounds, PET_MIN_SIZE.width, PET_MIN_SIZE.height);

    petWindow = new BrowserWindow({
        ...petBounds,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        resizable: false,
        movable: true,
        alwaysOnTop: true,
        skipTaskbar: desktopState.preferences.petSkipTaskbar,
        show: Boolean(petState.visible),
            title: 'HumanClaw Pet',
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });

    petWindow.setAlwaysOnTop(true, 'screen-saver');
    petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    openExternalLinks(petWindow);
    hookWindowPersistence('petWindow', petWindow);
    petWindow.on('show', sendPetWindowState);
    petWindow.on('hide', sendPetWindowState);
    petWindow.on('focus', sendPetWindowState);
    petWindow.on('blur', sendPetWindowState);
    petWindow.webContents.on('did-finish-load', sendPetWindowState);

    petWindow.on('close', (event) => {
        if (isQuitting) {
            return;
        }
        event.preventDefault();
        petWindow.hide();
        hideChatWindow();
    });

    petWindow.on('closed', () => {
        petWindow = null;
    });

    void loadWindowContent(petWindow, 'pet.html');
    if (!desktopState.petWindow.visible) {
        petWindow.hide();
    }
}

function createChatWindow() {
    const chatState = desktopState.chatWindow;
    const chatBounds = clampBoundsToDisplay(chatState.bounds, CHAT_MIN_WIDTH, CHAT_MIN_HEIGHT);

    chatWindow = new BrowserWindow({
        ...chatBounds,
        frame: false,
        transparent: false,
        backgroundColor: '#f8fbff',
        hasShadow: true,
        resizable: true,
        show: false,
        skipTaskbar: false,
        alwaysOnTop: true,
            title: 'HumanClaw Chat',
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });

    openExternalLinks(chatWindow);
    hookWindowPersistence('chatWindow', chatWindow);

    chatWindow.on('close', (event) => {
        if (isQuitting) {
            return;
        }
        event.preventDefault();
        chatWindow.hide();
    });

    chatWindow.on('closed', () => {
        chatWindow = null;
    });

    void loadWindowContent(chatWindow, 'chat.html').then(() => {
        if (desktopState.chatWindow.visible) {
            chatWindow.show();
        }
    });
}

function createControlWindow() {
    const controlState = desktopState.controlWindow;
    const controlBounds = clampBoundsToDisplay(controlState.bounds, CONTROL_MIN_WIDTH, CONTROL_MIN_HEIGHT);

    controlWindow = new BrowserWindow({
        ...controlBounds,
        frame: false,
        transparent: false,
        backgroundColor: '#0c1722',
        hasShadow: true,
        resizable: true,
        show: false,
        skipTaskbar: false,
        title: 'HumanClaw Control',
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });

    openExternalLinks(controlWindow);
    hookWindowPersistence('controlWindow', controlWindow);

    controlWindow.on('close', (event) => {
        if (isQuitting) {
            return;
        }
        event.preventDefault();
        controlWindow.hide();
    });

    controlWindow.on('closed', () => {
        controlWindow = null;
    });

    void loadWindowContent(controlWindow, 'control.html').then(() => {
        if (desktopState.controlWindow.visible) {
            controlWindow.show();
        }
        controlWindow.webContents.send('aigril:settings-updated', buildRuntimeSettingsPayload());
    });
}

function createSetupWindow() {
    const setupState = desktopState.setupWindow;
    const setupBounds = clampBoundsToDisplay(setupState.bounds, SETUP_MIN_WIDTH, SETUP_MIN_HEIGHT);

    setupWindow = new BrowserWindow({
        ...setupBounds,
        frame: false,
        transparent: false,
        backgroundColor: '#0d1b2b',
        hasShadow: true,
        resizable: true,
        show: false,
        skipTaskbar: false,
        alwaysOnTop: true,
        title: 'HumanClaw Setup',
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });

    openExternalLinks(setupWindow);
    hookWindowPersistence('setupWindow', setupWindow);

    setupWindow.on('close', (event) => {
        if (isQuitting) {
            return;
        }
        event.preventDefault();
        setupWindow.hide();
    });

    setupWindow.on('closed', () => {
        setupWindow = null;
    });

    void loadWindowContent(setupWindow, 'setup.html').then(() => {
        if (desktopState.setupWindow.visible || !desktopState.preferences.onboardingCompleted) {
            setupWindow.show();
        }
        setupWindow.webContents.send('aigril:settings-updated', buildRuntimeSettingsPayload());
    });
}

function refreshTrayMenu() {
    if (!tray) {
        return;
    }

    const menu = Menu.buildFromTemplate([
        {
            label: petWindow?.isVisible() ? '隐藏桌宠' : '显示桌宠',
            click: () => {
                if (!petWindow) {
                    createPetWindow();
                    return;
                }
                if (petWindow.isVisible()) {
                    petWindow.hide();
                    hideChatWindow();
                } else {
                    petWindow.show();
                    petWindow.focus();
                }
            }
        },
        {
            label: '聊天',
            click: () => showChatWindow()
        },
        {
            label: '控制面板',
            click: () => showControlWindow()
        },
        {
            label: '首启向导',
            click: () => showSetupWindow()
        },
        {
            label: '缩放',
            submenu: buildPetScaleMenu()
        },
        { type: 'separator' },
        {
            label: '桌宠显示在任务栏',
            type: 'checkbox',
            checked: !desktopState.preferences.petSkipTaskbar,
            click: (menuItem) => {
                desktopState.preferences.petSkipTaskbar = !menuItem.checked;
                if (petWindow) {
                    petWindow.setSkipTaskbar(desktopState.preferences.petSkipTaskbar);
                }
                persistDesktopState();
            }
        },
        { type: 'separator' },
        {
            label: '退出',
            click: () => quitApplication()
        }
    ]);

    tray.setContextMenu(menu);
    tray.setToolTip('HumanClaw 桌宠');
}

function createTray() {
    tray = new Tray(makeTrayIcon());
    tray.on('double-click', () => {
        if (!petWindow) {
            createPetWindow();
            return;
        }
        petWindow.show();
        petWindow.focus();
    });
    refreshTrayMenu();
}

function registerIpc() {
    ipcMain.handle('aigril:toggle-chat-window', () => toggleChatWindow());
    ipcMain.handle('aigril:show-chat-window', () => {
        showChatWindow();
        return true;
    });
    ipcMain.handle('aigril:hide-chat-window', () => {
        hideChatWindow();
        return false;
    });
    ipcMain.handle('aigril:show-pet-context-menu', () => showPetContextMenu());
    ipcMain.handle('aigril:show-control-window', () => {
        showControlWindow();
        return true;
    });
    ipcMain.handle('aigril:show-setup-window', () => {
        showSetupWindow();
        return true;
    });
    ipcMain.handle('aigril:get-runtime-settings', () => buildRuntimeSettingsPayload());
    ipcMain.handle('aigril:save-runtime-settings', (_event, payload = {}) => {
        return updateDesktopPreferences(payload || {});
    });
    ipcMain.handle('aigril:set-recognition-mode', (_event, mode) => {
        return updateDesktopPreferences({
            recognitionMode: mode
        });
    });
    ipcMain.handle('aigril:set-preferred-mic-device', (_event, deviceId) => {
        return updateDesktopPreferences({
            preferredMicDeviceId: deviceId
        });
    });
    ipcMain.handle('aigril:complete-onboarding', (_event, payload = {}) => {
        const nextSettings = updateDesktopPreferences({
            ...payload,
            onboardingCompleted: true
        });
        return refreshAssistantHealth({ probe: true })
            .then(() => buildRuntimeSettingsPayload())
            .catch(() => nextSettings);
    });
    ipcMain.handle('aigril:run-runtime-health-check', async () => {
        await refreshAssistantHealth({ probe: true });
        return buildRuntimeSettingsPayload();
    });
    ipcMain.handle('aigril:close-current-window', (event) => {
        const ownerWindow = BrowserWindow.fromWebContents(event.sender);
        if (ownerWindow && !ownerWindow.isDestroyed()) {
            ownerWindow.hide();
        }
        return true;
    });
    ipcMain.handle('aigril:assistant-status', async () => {
        const status = ensureAssistantGateway().getStatus();
        status.health = assistantHealthState || buildAssistantHealthSnapshot(buildRuntimeSettingsCore(), {
            gatewayStatus: status
        });
        return status;
    });
    ipcMain.handle('aigril:assistant-history', async (_event, payload = {}) => {
        return ensureAssistantGateway().getHistory(Number(payload.limit) || 200);
    });
    ipcMain.handle('aigril:assistant-send-message', async (_event, payload = {}) => {
        return ensureAssistantGateway().sendMessage(payload.content || '', {
            timeoutMs: Number(payload.timeoutMs) || undefined
        });
    });
    ipcMain.handle('aigril:assistant-abort-run', async (_event, payload = {}) => {
        return ensureAssistantGateway().abortRun(payload.runId || '');
    });
    ipcMain.handle('aigril:assistant-list-sessions', async (_event, payload = {}) => {
        return ensureAssistantGateway().listSessions(Number(payload.limit) || 20);
    });
    ipcMain.handle('aigril:assistant-set-session-key', async (_event, payload = {}) => {
        return ensureAssistantGateway().setSessionKey(payload.sessionKey || '');
    });
    ipcMain.handle('aigril:assistant-patch-session', async (_event, payload = {}) => {
        return ensureAssistantGateway().patchSession(payload || {});
    });
    ipcMain.handle('aigril:asr-transcribe', async (_event, payload = {}) => handleAsrTranscribeRequest(payload));
    ipcMain.handle('aigril:transcribe-audio', async (_event, payload = {}) => handleAsrTranscribeRequest(payload));

    ipcMain.on('aigril:drag-pet-window', (_event, payload = {}) => {
        if (!petWindow) {
            return;
        }

        const bounds = petWindow.getBounds();
        const nextBounds = clampBoundsToDisplay({
            ...bounds,
            x: Math.round(bounds.x + Number(payload.deltaX || 0)),
            y: Math.round(bounds.y + Number(payload.deltaY || 0))
        }, PET_MIN_SIZE.width, PET_MIN_SIZE.height);

        petWindow.setBounds(nextBounds);
    });

    ipcMain.on('aigril:chat-send-message', (_event, payload = {}) => {
        petWindow?.webContents.send('aigril:chat-send-message', payload);
        showChatWindow();
    });

    ipcMain.on('aigril:pet-chat-event', (_event, payload = {}) => {
        if (chatWindow) {
            chatWindow.webContents.send('aigril:chat-event', payload);
        }
    });

    ipcMain.on('aigril:chat-state-sync-request', () => {
        petWindow?.webContents.send('aigril:chat-state-sync-request', {});
    });
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (petWindow) {
            petWindow.show();
            petWindow.focus();
        }
        showChatWindow();
    });
}

app.whenReady().then(async () => {
    configureMediaPermissions();
    desktopState = loadDesktopState(app);
    desktopState = saveDesktopState(app, desktopState);
    syncRuntimeEnvironment();
    applyLoginPreference();
    ensureAssistantGateway();
    desktopASRManager = new DesktopASRManager({ app });
    Menu.setApplicationMenu(null);
    registerIpc();
    createPetWindow();
    createChatWindow();
    createTray();
    if (!desktopState.preferences.onboardingCompleted) {
        createSetupWindow();
    }

    if (assistantGateway?.getStatus().enabled) {
        await assistantGateway.ensureConnected().catch(() => {
            // Keep the desktop available even when the local gateway is offline.
        });
    }
    await refreshAssistantHealth({ probe: true }).catch(() => {});
    setTimeout(() => {
        desktopASRManager?.warmup?.().catch((error) => {
            console.warn('[ASR] 后台预热失败：', error.message || error);
        });
    }, 4000);

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createPetWindow();
            createChatWindow();
            if (!desktopState.preferences.onboardingCompleted) {
                createSetupWindow();
            }
            if (!tray) {
                createTray();
            }
        } else if (petWindow) {
            petWindow.show();
        }
    });
});

app.on('before-quit', () => {
    isQuitting = true;
    void assistantGateway?.shutdown();
    desktopASRManager?.close?.();
});

app.on('window-all-closed', () => {
    // 托盘常驻形态下，窗口全部关闭并不等于退出应用。
});
