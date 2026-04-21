export const BACKEND_MODE_OPTIONS = [
    {
        id: 'companion-service',
        label: '陪伴后端',
        subtitle: 'Render 服务',
        description: '所有对话都走你的 Render 或自定义后端，适合偏陪伴、偏聊天的桌宠形态。',
        accent: '#58b88b'
    },
    {
        id: 'openclaw-local',
        label: '本地 OpenClaw',
        subtitle: '外部安装',
        description: '只连接你已经自行安装并启动的 OpenClaw。HumanClaw 不负责部署、拉起和配置它。',
        accent: '#f08a54'
    }
];

export const DEFAULT_RUNTIME_SETTINGS = {
    backendMode: 'companion-service',
    onboardingCompleted: false,
    autoLaunchOnLogin: false,
    petScale: 0.85,
    petSkipTaskbar: true,
    cameraDistance: 1.1,
    cameraTargetY: 1.0,
    backendBaseUrl: 'https://airi-backend.onrender.com',
    openclawGatewayUrl: 'ws://127.0.0.1:19011',
    voiceInputEnabled: true,
    voiceOutputEnabled: true,
    recognitionMode: 'manual',
    preferredMicDeviceId: ''
};

export function getBackendModeById(modeId = 'companion-service') {
    return BACKEND_MODE_OPTIONS.find((item) => item.id === modeId) || BACKEND_MODE_OPTIONS[0];
}

export function normalizeBackendMode(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (BACKEND_MODE_OPTIONS.some((item) => item.id === normalized)) {
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
    return DEFAULT_RUNTIME_SETTINGS.backendMode;
}

export function normalizeRuntimeSettings(input = {}) {
    const next = {
        ...DEFAULT_RUNTIME_SETTINGS,
        ...(input || {})
    };

    next.backendMode = normalizeBackendMode(next.backendMode || next.installEdition);
    next.petScale = Number.isFinite(Number(next.petScale)) ? Number(next.petScale) : DEFAULT_RUNTIME_SETTINGS.petScale;
    next.cameraDistance = Number.isFinite(Number(next.cameraDistance))
        ? Number(next.cameraDistance)
        : DEFAULT_RUNTIME_SETTINGS.cameraDistance;
    next.cameraTargetY = Number.isFinite(Number(next.cameraTargetY))
        ? Number(next.cameraTargetY)
        : DEFAULT_RUNTIME_SETTINGS.cameraTargetY;
    next.backendBaseUrl =
        String(next.backendBaseUrl || DEFAULT_RUNTIME_SETTINGS.backendBaseUrl).trim() ||
        DEFAULT_RUNTIME_SETTINGS.backendBaseUrl;
    next.openclawGatewayUrl =
        String(next.openclawGatewayUrl || DEFAULT_RUNTIME_SETTINGS.openclawGatewayUrl).trim() ||
        DEFAULT_RUNTIME_SETTINGS.openclawGatewayUrl;
    next.voiceInputEnabled = next.voiceInputEnabled !== false;
    next.voiceOutputEnabled = next.voiceOutputEnabled !== false;
    next.recognitionMode = String(next.recognitionMode || DEFAULT_RUNTIME_SETTINGS.recognitionMode)
        .trim()
        .toLowerCase() === 'manual'
        ? 'manual'
        : DEFAULT_RUNTIME_SETTINGS.recognitionMode;
    next.preferredMicDeviceId = String(next.preferredMicDeviceId || '').trim();
    next.autoLaunchOnLogin = Boolean(next.autoLaunchOnLogin);
    next.petSkipTaskbar = next.petSkipTaskbar !== false;
    next.onboardingCompleted = Boolean(next.onboardingCompleted);

    return next;
}

export function getRuntimeSettingsSnapshot() {
    return normalizeRuntimeSettings(window.aigrilDesktop?.runtimeConfig || {});
}

export async function resolveRuntimeSettings() {
    if (!window.aigrilDesktop?.getRuntimeSettings) {
        return getRuntimeSettingsSnapshot();
    }

    try {
        return normalizeRuntimeSettings(await window.aigrilDesktop.getRuntimeSettings());
    } catch {
        return getRuntimeSettingsSnapshot();
    }
}

export function subscribeRuntimeSettings(listener) {
    if (!window.aigrilDesktop?.onSettingsUpdate) {
        return () => {};
    }

    return window.aigrilDesktop.onSettingsUpdate((payload) => {
        listener(normalizeRuntimeSettings(payload));
    });
}

export async function saveRuntimeSettings(patch) {
    if (!window.aigrilDesktop?.saveRuntimeSettings) {
        return normalizeRuntimeSettings({
            ...getRuntimeSettingsSnapshot(),
            ...(patch || {})
        });
    }

    return normalizeRuntimeSettings(await window.aigrilDesktop.saveRuntimeSettings(patch || {}));
}

export async function completeRuntimeOnboarding(patch) {
    if (!window.aigrilDesktop?.completeOnboarding) {
        return saveRuntimeSettings({
            ...(patch || {}),
            onboardingCompleted: true
        });
    }

    return normalizeRuntimeSettings(await window.aigrilDesktop.completeOnboarding(patch || {}));
}

export async function runRuntimeHealthCheck() {
    if (!window.aigrilDesktop?.runRuntimeHealthCheck) {
        return resolveRuntimeSettings();
    }

    return normalizeRuntimeSettings(await window.aigrilDesktop.runRuntimeHealthCheck());
}
