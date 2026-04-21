const fs = require('fs');
const path = require('path');
const { screen } = require('electron');
const { getBundledInstallEdition } = require('./app-edition.cjs');

const STATE_FILE_NAME = 'desktop-state.json';
const STATE_VERSION = 3;
const PET_BASE_WIDTH = 360;
const PET_BASE_HEIGHT = 560;
const PET_SCALE_OPTIONS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.85, 1, 1.15];
const DEFAULT_PET_SCALE = 0.85;
const BACKEND_MODES = ['companion-service', 'openclaw-local'];
const INSTALL_EDITIONS = ['companion', 'assistant', 'operator'];
const ASSISTANT_PROVIDER_IDS = ['openrouter', 'openai', 'openai-codex', 'anthropic', 'ollama'];
const COMPANION_BACKEND_DEFAULT_URL = 'https://airi-backend.onrender.com';
const LEGACY_COMPANION_BACKEND_URLS = new Set([
    'http://127.0.0.1:8000',
    'http://localhost:8000'
]);

function clampNumber(value, minimum, maximum, fallback) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return fallback;
    }

    return Math.min(Math.max(numericValue, minimum), maximum);
}

function normalizeOptionalString(value, fallback = '') {
    if (typeof value !== 'string') {
        return fallback;
    }

    const trimmed = value.trim();
    return trimmed || fallback;
}

function normalizeBoolean(value, fallback = false) {
    if (typeof value === 'boolean') {
        return value;
    }
    return fallback;
}

function normalizeRecognitionMode(value, fallback = 'manual') {
    const normalized = normalizeOptionalString(value, fallback).toLowerCase();
    return normalized === 'manual' ? 'manual' : fallback;
}

function normalizePreferredMicDeviceId(value) {
    return normalizeOptionalString(value, '');
}

function normalizeInstallEdition(value) {
    const normalized = normalizeOptionalString(value, 'assistant').toLowerCase();
    return INSTALL_EDITIONS.includes(normalized) ? normalized : 'assistant';
}

function normalizeBackendMode(value, fallback = 'companion-service') {
    const normalized = normalizeOptionalString(value, '').toLowerCase();
    if (BACKEND_MODES.includes(normalized)) {
        return normalized;
    }

    if (normalized === 'openclaw' || normalized === 'aigril') {
        return 'openclaw-local';
    }

    const legacyEdition = normalizeInstallEdition(value);
    if (legacyEdition === 'companion') {
        return 'companion-service';
    }

    if (legacyEdition === 'assistant' || legacyEdition === 'operator') {
        return 'openclaw-local';
    }

    return fallback;
}

function getDefaultFeatureGrants(edition = 'assistant') {
    if (edition === 'operator') {
        return {
            workspaceWrite: true,
            hostExec: true,
            destructiveOps: true,
            fullDiskAccess: true
        };
    }

    if (edition === 'assistant') {
        return {
            workspaceWrite: true,
            hostExec: false,
            destructiveOps: false,
            fullDiskAccess: false
        };
    }

    return {
        workspaceWrite: false,
        hostExec: false,
        destructiveOps: false,
        fullDiskAccess: false
    };
}

function getDefaultPreferences(installEdition = 'assistant') {
    return {
        petSkipTaskbar: true,
        petScale: DEFAULT_PET_SCALE,
        installEdition,
        backendMode: 'companion-service',
        onboardingCompleted: false,
        autoLaunchOnLogin: false,
        backendBaseUrl: COMPANION_BACKEND_DEFAULT_URL,
        openclawGatewayUrl: 'ws://127.0.0.1:19011',
        voiceInputEnabled: true,
        voiceOutputEnabled: true,
        recognitionMode: 'manual',
        preferredMicDeviceId: '',
        cameraDistance: 1.1,
        cameraTargetY: 1.0,
        assistantProvider: {
            providerId: 'openrouter',
            modelId: 'openrouter/auto'
        },
        featureGrants: getDefaultFeatureGrants(installEdition)
    };
}

function normalizeAssistantProvider(input) {
    const next = input && typeof input === 'object' ? input : {};
    const providerId = normalizeOptionalString(next.providerId, 'openrouter').toLowerCase();
    const normalizedProviderId = ASSISTANT_PROVIDER_IDS.includes(providerId) ? providerId : 'openrouter';

    return {
        providerId: normalizedProviderId,
        modelId: normalizeOptionalString(
            next.modelId,
            normalizedProviderId === 'openrouter' ? 'openrouter/auto' : ''
        )
    };
}

function normalizePetScale(scale) {
    const numericScale = Number(scale);
    if (!Number.isFinite(numericScale)) {
        return DEFAULT_PET_SCALE;
    }

    return PET_SCALE_OPTIONS.reduce((closestScale, option) => {
        const nextDistance = Math.abs(option - numericScale);
        const closestDistance = Math.abs(closestScale - numericScale);
        return nextDistance < closestDistance ? option : closestScale;
    }, PET_SCALE_OPTIONS[0]);
}

function getScaledPetSize(scale = DEFAULT_PET_SCALE) {
    const normalizedScale = normalizePetScale(scale);
    return {
        width: Math.round(PET_BASE_WIDTH * normalizedScale),
        height: Math.round(PET_BASE_HEIGHT * normalizedScale)
    };
}

function resizePetBounds(bounds, scale = DEFAULT_PET_SCALE) {
    const nextSize = getScaledPetSize(scale);
    const centerX = bounds.x + bounds.width / 2;
    const bottomY = bounds.y + bounds.height;

    return {
        x: Math.round(centerX - nextSize.width / 2),
        y: Math.round(bottomY - nextSize.height),
        width: nextSize.width,
        height: nextSize.height
    };
}

function getDefaultState(installEdition = 'assistant') {
    const workArea = screen.getPrimaryDisplay().workArea;
    const petScale = DEFAULT_PET_SCALE;
    const petSize = getScaledPetSize(petScale);
    const chatWidth = 420;
    const chatHeight = 620;

    const petX = workArea.x + workArea.width - petSize.width - 32;
    const petY = workArea.y + workArea.height - petSize.height - 24;
    const chatX = Math.max(workArea.x + 24, petX - chatWidth - 24);
    const chatY = Math.max(workArea.y + 24, petY + 32);

    return {
        version: STATE_VERSION,
        petWindow: {
            bounds: {
                x: petX,
                y: petY,
                width: petSize.width,
                height: petSize.height
            },
            visible: true
        },
        chatWindow: {
            bounds: {
                x: chatX,
                y: chatY,
                width: chatWidth,
                height: chatHeight
            },
            visible: false
        },
        controlWindow: {
            bounds: {
                x: Math.max(workArea.x + 36, chatX - 40),
                y: Math.max(workArea.y + 36, workArea.y + 56),
                width: 980,
                height: 720
            },
            visible: false
        },
        setupWindow: {
            bounds: {
                x: workArea.x + Math.max(48, Math.round((workArea.width - 960) / 2)),
                y: workArea.y + Math.max(40, Math.round((workArea.height - 700) / 2)),
                width: 960,
                height: 700
            },
            visible: false
        },
        preferences: getDefaultPreferences(installEdition)
    };
}

function getStateFilePath(app) {
    return path.join(app.getPath('userData'), STATE_FILE_NAME);
}

function normalizeState(inputState, installEdition = 'assistant') {
    const defaults = getDefaultState(installEdition);
    const nextState = inputState && typeof inputState === 'object' ? inputState : {};
    const legacyVersion = Number(nextState.version) || 0;

    const normalizedState = {
        ...defaults,
        ...nextState,
        petWindow: {
            ...defaults.petWindow,
            ...(nextState.petWindow || {}),
            bounds: {
                ...defaults.petWindow.bounds,
                ...(nextState.petWindow?.bounds || {})
            }
        },
        chatWindow: {
            ...defaults.chatWindow,
            ...(nextState.chatWindow || {}),
            bounds: {
                ...defaults.chatWindow.bounds,
                ...(nextState.chatWindow?.bounds || {})
            }
        },
        controlWindow: {
            ...defaults.controlWindow,
            ...(nextState.controlWindow || {}),
            bounds: {
                ...defaults.controlWindow.bounds,
                ...(nextState.controlWindow?.bounds || {})
            }
        },
        setupWindow: {
            ...defaults.setupWindow,
            ...(nextState.setupWindow || {}),
            bounds: {
                ...defaults.setupWindow.bounds,
                ...(nextState.setupWindow?.bounds || {})
            }
        },
        preferences: {
            ...defaults.preferences,
            ...(nextState.preferences || {})
        }
    };

    normalizedState.preferences.petScale = normalizePetScale(normalizedState.preferences.petScale);
    normalizedState.preferences.installEdition = normalizeInstallEdition(normalizedState.preferences.installEdition);
    normalizedState.preferences.backendMode = normalizeBackendMode(
        normalizedState.preferences.backendMode || normalizedState.preferences.installEdition
    );
    normalizedState.preferences.onboardingCompleted = normalizeBoolean(
        normalizedState.preferences.onboardingCompleted,
        defaults.preferences.onboardingCompleted
    );
    normalizedState.preferences.autoLaunchOnLogin = normalizeBoolean(
        normalizedState.preferences.autoLaunchOnLogin,
        defaults.preferences.autoLaunchOnLogin
    );
    normalizedState.preferences.petSkipTaskbar = normalizeBoolean(
        normalizedState.preferences.petSkipTaskbar,
        defaults.preferences.petSkipTaskbar
    );
    normalizedState.preferences.voiceInputEnabled = normalizeBoolean(
        normalizedState.preferences.voiceInputEnabled,
        defaults.preferences.voiceInputEnabled
    );
    normalizedState.preferences.voiceOutputEnabled = normalizeBoolean(
        normalizedState.preferences.voiceOutputEnabled,
        defaults.preferences.voiceOutputEnabled
    );
    normalizedState.preferences.recognitionMode = normalizeRecognitionMode(
        normalizedState.preferences.recognitionMode,
        defaults.preferences.recognitionMode
    );
    normalizedState.preferences.preferredMicDeviceId = normalizePreferredMicDeviceId(
        normalizedState.preferences.preferredMicDeviceId
    );
    normalizedState.preferences.backendBaseUrl = normalizeOptionalString(
        normalizedState.preferences.backendBaseUrl,
        defaults.preferences.backendBaseUrl
    );
    if (LEGACY_COMPANION_BACKEND_URLS.has(normalizedState.preferences.backendBaseUrl)) {
        normalizedState.preferences.backendBaseUrl = COMPANION_BACKEND_DEFAULT_URL;
    }
    normalizedState.preferences.openclawGatewayUrl = normalizeOptionalString(
        normalizedState.preferences.openclawGatewayUrl,
        defaults.preferences.openclawGatewayUrl
    );
    normalizedState.preferences.cameraDistance = clampNumber(
        normalizedState.preferences.cameraDistance,
        0.85,
        1.8,
        defaults.preferences.cameraDistance
    );
    normalizedState.preferences.cameraTargetY = clampNumber(
        normalizedState.preferences.cameraTargetY,
        0.65,
        1.25,
        defaults.preferences.cameraTargetY
    );
    normalizedState.preferences.assistantProvider = normalizeAssistantProvider(
        normalizedState.preferences.assistantProvider
    );

    const defaultFeatureGrants = getDefaultFeatureGrants(normalizedState.preferences.installEdition);
    const nextFeatureGrants =
        normalizedState.preferences.featureGrants &&
        typeof normalizedState.preferences.featureGrants === 'object'
            ? normalizedState.preferences.featureGrants
            : {};
    normalizedState.preferences.featureGrants = {
        workspaceWrite: normalizeBoolean(nextFeatureGrants.workspaceWrite, defaultFeatureGrants.workspaceWrite),
        hostExec: normalizeBoolean(nextFeatureGrants.hostExec, defaultFeatureGrants.hostExec),
        destructiveOps: normalizeBoolean(nextFeatureGrants.destructiveOps, defaultFeatureGrants.destructiveOps),
        fullDiskAccess: normalizeBoolean(nextFeatureGrants.fullDiskAccess, defaultFeatureGrants.fullDiskAccess)
    };

    if ((nextState.version || 0) < STATE_VERSION) {
        normalizedState.petWindow.bounds = resizePetBounds(
            normalizedState.petWindow.bounds,
            normalizedState.preferences.petScale
        );
    }

    if (legacyVersion > 0 && legacyVersion < STATE_VERSION) {
        normalizedState.preferences.onboardingCompleted = true;
    }

    normalizedState.version = STATE_VERSION;
    return normalizedState;
}

function loadDesktopState(app) {
    const filePath = getStateFilePath(app);
    const installEdition = getBundledInstallEdition(app);
    try {
        if (!fs.existsSync(filePath)) {
            return getDefaultState(installEdition);
        }
        return normalizeState(JSON.parse(fs.readFileSync(filePath, 'utf8')), installEdition);
    } catch (error) {
        console.warn('⚠️ 读取桌宠状态失败，回退默认值：', error);
        return getDefaultState(installEdition);
    }
}

function saveDesktopState(app, nextState) {
    const normalized = normalizeState(nextState, getBundledInstallEdition(app));
    const filePath = getStateFilePath(app);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), 'utf8');
    return normalized;
}

module.exports = {
    DEFAULT_PET_SCALE,
    INSTALL_EDITIONS,
    PET_SCALE_OPTIONS,
    getDefaultFeatureGrants,
    getDefaultPreferences,
    getDefaultState,
    getScaledPetSize,
    loadDesktopState,
    normalizePreferredMicDeviceId,
    normalizePetScale,
    normalizeRecognitionMode,
    normalizeState,
    resizePetBounds,
    saveDesktopState
};
