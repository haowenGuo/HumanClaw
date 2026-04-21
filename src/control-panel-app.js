import {
    BACKEND_MODE_OPTIONS,
    getBackendModeById,
    normalizeRuntimeSettings,
    resolveRuntimeSettings,
    runRuntimeHealthCheck,
    saveRuntimeSettings,
    subscribeRuntimeSettings
} from './runtime-settings.js';

const sectionTargets = Array.from(document.querySelectorAll('.nav-btn'));
const sectionElements = new Map(
    sectionTargets.map((button) => [button.dataset.target, document.getElementById(button.dataset.target)])
);

const state = {
    settings: null,
    dirty: false,
    assistantStatus: null
};

let microphoneDevices = [];

const elements = {
    sidebarEditionLabel: document.getElementById('sidebar-edition-label'),
    editionGrid: document.getElementById('edition-grid'),
    statEdition: document.getElementById('stat-edition'),
    statEditionCopy: document.getElementById('stat-edition-copy'),
    statVoice: document.getElementById('stat-voice'),
    statProvider: document.getElementById('stat-provider'),
    statProviderCopy: document.getElementById('stat-provider-copy'),
    statRisk: document.getElementById('stat-risk'),
    statRiskCopy: document.getElementById('stat-risk-copy'),
    petScaleInput: document.getElementById('pet-scale-input'),
    petScaleValue: document.getElementById('pet-scale-value'),
    cameraDistanceInput: document.getElementById('camera-distance-input'),
    cameraDistanceValue: document.getElementById('camera-distance-value'),
    cameraTargetYInput: document.getElementById('camera-target-y-input'),
    cameraTargetYValue: document.getElementById('camera-target-y-value'),
    petSkipTaskbarInput: document.getElementById('pet-skip-taskbar-input'),
    autoLaunchInput: document.getElementById('auto-launch-input'),
    assistantStatusPill: document.getElementById('assistant-status-pill'),
    assistantStatusDetail: document.getElementById('assistant-status-detail'),
    assistantRefreshBtn: document.getElementById('assistant-refresh-btn'),
    backendBaseUrlInput: document.getElementById('backend-base-url-input'),
    gatewayUrlInput: document.getElementById('gateway-url-input'),
    voiceInputEnabledInput: document.getElementById('voice-input-enabled-input'),
    voiceOutputEnabledInput: document.getElementById('voice-output-enabled-input'),
    recognitionModeText: document.getElementById('recognition-mode-text'),
    preferredMicInput: document.getElementById('preferred-mic-input'),
    refreshMicsBtn: document.getElementById('refresh-mics-btn'),
    micHelp: document.getElementById('mic-help'),
    saveFeedback: document.getElementById('save-feedback'),
    openSetupBtn: document.getElementById('open-setup-btn'),
    saveSettingsBtn: document.getElementById('save-settings-btn'),
    topbarSaveBtn: document.getElementById('topbar-save-btn'),
    closeBtn: document.getElementById('window-close-btn'),
    pageScroll: document.getElementById('page-scroll')
};

function cloneSettings(input) {
    return normalizeRuntimeSettings({
        ...(input || {})
    });
}

function formatScale(value) {
    return `${Math.round(Number(value) * 100)}%`;
}

function formatDistance(value) {
    return `${Number(value).toFixed(2)}x`;
}

function formatHeight(value) {
    return `${Number(value).toFixed(2)}`;
}

function getVoiceSummary(settings) {
    if (settings.voiceInputEnabled && settings.voiceOutputEnabled) {
        return '双向开启';
    }
    if (settings.voiceInputEnabled) {
        return '仅识别开启';
    }
    if (settings.voiceOutputEnabled) {
        return '仅播报开启';
    }
    return '已关闭';
}

function getBackendCopy(settings) {
    const mode = getBackendModeById(settings.backendMode);
    if (mode.id === 'companion-service') {
        return `当前所有对话默认走 ${settings.backendBaseUrl}`;
    }
    return '只连接你自己装好的本地 OpenClaw，不负责部署和配置。';
}

function applyNavState(activeId) {
    sectionTargets.forEach((button) => {
        button.classList.toggle('is-active', button.dataset.target === activeId);
    });
}

function collectSettingsFromForm() {
    if (!state.settings) {
        return null;
    }

    return cloneSettings({
        ...state.settings,
        petScale: Number(elements.petScaleInput.value),
        cameraDistance: Number(elements.cameraDistanceInput.value),
        cameraTargetY: Number(elements.cameraTargetYInput.value),
        petSkipTaskbar: !elements.petSkipTaskbarInput.checked,
        autoLaunchOnLogin: elements.autoLaunchInput.checked,
        backendBaseUrl: String(elements.backendBaseUrlInput.value || '').trim(),
        openclawGatewayUrl: String(elements.gatewayUrlInput.value || '').trim(),
        voiceInputEnabled: elements.voiceInputEnabledInput.checked,
        voiceOutputEnabled: elements.voiceOutputEnabledInput.checked,
        recognitionMode: String(state.settings.recognitionMode || 'manual').trim().toLowerCase(),
        preferredMicDeviceId: String(elements.preferredMicInput.value || '').trim()
    });
}

function markDirty(nextDirty = true) {
    state.dirty = nextDirty;
    elements.saveFeedback.textContent = nextDirty ? '有未保存改动' : '已保存到本机';
    if (elements.topbarSaveBtn) {
        elements.topbarSaveBtn.disabled = false;
        elements.topbarSaveBtn.textContent = nextDirty ? '保存配置' : '已保存';
    }
    if (elements.saveSettingsBtn) {
        elements.saveSettingsBtn.disabled = false;
    }
}

function renderAssistantStatus() {
    const status = state.assistantStatus;
    const settings = state.settings;

    if (!settings || !status) {
        elements.assistantStatusPill.textContent = '正在检查连接';
        elements.assistantStatusPill.className = 'status-pill is-warning';
        elements.assistantStatusDetail.textContent = '稍后会显示当前对话后端和本地 OpenClaw 状态。';
        return;
    }

    if (settings.backendMode === 'companion-service') {
        elements.assistantStatusPill.textContent = '当前走陪伴后端';
        elements.assistantStatusPill.className = 'status-pill is-warning';
        elements.assistantStatusDetail.textContent =
            settings.assistantHealth?.reason ||
            `HumanClaw 会把对话交给 ${settings.backendBaseUrl}，不会接管 OpenClaw 的安装和配置。`;
        return;
    }

    if (status.connected) {
        elements.assistantStatusPill.textContent = 'OpenClaw 已连接';
        elements.assistantStatusPill.className = 'status-pill is-online';
        elements.assistantStatusDetail.textContent = `${status.gatewayUrl || settings.openclawGatewayUrl} / session ${status.sessionKey || 'main'}`;
        return;
    }

    if (status.connecting) {
        elements.assistantStatusPill.textContent = 'OpenClaw 连接中';
        elements.assistantStatusPill.className = 'status-pill is-warning';
        elements.assistantStatusDetail.textContent =
            settings.assistantHealth?.reason ||
            `${status.gatewayUrl || settings.openclawGatewayUrl} 正在握手，稍后会自动重试。`;
        return;
    }

    elements.assistantStatusPill.textContent = 'OpenClaw 未连接';
    elements.assistantStatusPill.className = 'status-pill is-offline';
    elements.assistantStatusDetail.textContent =
        settings.assistantHealth?.reason ||
        status.lastError ||
        `尚未连上 ${status.gatewayUrl || settings.openclawGatewayUrl}`;
}

function syncMicrophoneSelection() {
    const currentValue = String(state.settings?.preferredMicDeviceId || '').trim();
    const previousValue = String(elements.preferredMicInput?.value || '').trim();
    const selectedValue = previousValue || currentValue;

    if (!elements.preferredMicInput) {
        return;
    }

    elements.preferredMicInput.innerHTML = '';

    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = '系统默认麦克风';
    elements.preferredMicInput.appendChild(defaultOption);

    if (!microphoneDevices.length) {
        if (currentValue) {
            const option = document.createElement('option');
            option.value = currentValue;
            option.textContent = '已保存设备（当前未发现）';
            elements.preferredMicInput.appendChild(option);
        }

        elements.preferredMicInput.value = currentValue;
        return;
    }

    microphoneDevices.forEach((device, index) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `麦克风 ${index + 1}`;
        elements.preferredMicInput.appendChild(option);
    });

    const hasSelected = microphoneDevices.some((device) => device.deviceId === selectedValue);
    if (!hasSelected && selectedValue) {
        const preservedOption = document.createElement('option');
        preservedOption.value = selectedValue;
        preservedOption.textContent = '已保存设备（当前未连接）';
        elements.preferredMicInput.appendChild(preservedOption);
    }

    elements.preferredMicInput.value = hasSelected || selectedValue ? selectedValue : '';
}

async function refreshMicrophones({ requestPermission = false } = {}) {
    if (!elements.micHelp || !elements.preferredMicInput) {
        return;
    }

    if (!navigator.mediaDevices?.enumerateDevices) {
        microphoneDevices = [];
        elements.micHelp.textContent = '当前桌面环境不支持枚举音频输入设备。';
        syncMicrophoneSelection();
        return;
    }

    try {
        if (requestPermission && navigator.mediaDevices.getUserMedia) {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach((track) => track.stop());
        }

        const devices = await navigator.mediaDevices.enumerateDevices();
        microphoneDevices = devices.filter((device) => device.kind === 'audioinput');
        elements.micHelp.textContent = microphoneDevices.length
            ? `共发现 ${microphoneDevices.length} 个音频输入设备。`
            : '还没有识别到可用麦克风，插拔设备后可重新刷新。';
        syncMicrophoneSelection();
    } catch (error) {
        microphoneDevices = [];
        elements.micHelp.textContent = `读取麦克风失败：${error.message || error}`;
        syncMicrophoneSelection();
    }
}

function renderSettings() {
    const settings = state.settings;
    if (!settings) {
        return;
    }

    const mode = getBackendModeById(settings.backendMode);

    elements.sidebarEditionLabel.textContent = mode.label;
    elements.statEdition.textContent = mode.label;
    elements.statEditionCopy.textContent = getBackendCopy(settings);
    elements.statVoice.textContent = getVoiceSummary(settings);
    elements.statProvider.textContent = settings.backendMode === 'openclaw-local' ? '本地 OpenClaw' : '陪伴服务';
    elements.statProviderCopy.textContent = settings.backendMode === 'openclaw-local'
        ? settings.openclawGatewayUrl
        : settings.backendBaseUrl;
    elements.statRisk.textContent = settings.assistantHealth?.ready ? '已打通' : (settings.backendMode === 'openclaw-local' ? '待连接' : '轻模式');
    elements.statRiskCopy.textContent = settings.assistantHealth?.reason || (
        settings.backendMode === 'openclaw-local'
            ? 'HumanClaw 只负责连本地 Gateway，不负责 OpenClaw 的模型和权限配置。'
            : '更偏陪伴与聊天，不主动接管本机工程能力。'
    );

    elements.petScaleInput.value = String(settings.petScale);
    elements.petScaleValue.textContent = formatScale(settings.petScale);
    elements.cameraDistanceInput.value = String(settings.cameraDistance);
    elements.cameraDistanceValue.textContent = formatDistance(settings.cameraDistance);
    elements.cameraTargetYInput.value = String(settings.cameraTargetY);
    elements.cameraTargetYValue.textContent = formatHeight(settings.cameraTargetY);
    elements.petSkipTaskbarInput.checked = !settings.petSkipTaskbar;
    elements.autoLaunchInput.checked = Boolean(settings.autoLaunchOnLogin);
    elements.backendBaseUrlInput.value = settings.backendBaseUrl || '';
    elements.gatewayUrlInput.value = settings.openclawGatewayUrl || '';
    elements.voiceInputEnabledInput.checked = Boolean(settings.voiceInputEnabled);
    elements.voiceOutputEnabledInput.checked = Boolean(settings.voiceOutputEnabled);
    if (elements.recognitionModeText) {
        elements.recognitionModeText.textContent = settings.recognitionMode === 'manual'
            ? 'manual / 手动录音'
            : settings.recognitionMode || 'manual';
    }
    if (elements.preferredMicInput) {
        elements.preferredMicInput.disabled = !settings.voiceInputEnabled;
    }
    if (elements.refreshMicsBtn) {
        elements.refreshMicsBtn.disabled = !settings.voiceInputEnabled;
    }
    if (elements.micHelp && !settings.voiceInputEnabled) {
        elements.micHelp.textContent = '当前已关闭本地语音识别，开启后才能选择麦克风。';
    }
    syncMicrophoneSelection();

    Array.from(elements.editionGrid.children).forEach((card) => {
        card.classList.toggle('is-selected', card.dataset.backendModeId === settings.backendMode);
    });

    renderAssistantStatus();
}

function buildBackendModeCard(option) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'edition-card';
    button.dataset.backendModeId = option.id;
    button.style.setProperty('--card-accent', option.accent);
    button.innerHTML = `
        <div class="edition-meta">
            <div class="edition-name">${option.label}</div>
            <div class="edition-badge">${option.subtitle}</div>
        </div>
        <div class="edition-copy">${option.description}</div>
    `;
    button.addEventListener('click', () => {
        if (!state.settings) {
            return;
        }

        state.settings.backendMode = option.id;
        renderSettings();
        markDirty(true);
    });
    return button;
}

async function refreshAssistantStatus() {
    try {
        state.assistantStatus = await window.aigrilDesktop?.assistant?.getStatus?.();
    } catch (error) {
        state.assistantStatus = {
            connected: false,
            connecting: false,
            enabled: state.settings?.backendMode === 'openclaw-local',
            gatewayUrl: state.settings?.openclawGatewayUrl || '',
            lastError: error?.message || 'OpenClaw Gateway 状态读取失败'
        };
    }

    renderAssistantStatus();
}

async function saveCurrentSettings() {
    const nextSettings = collectSettingsFromForm();
    if (!nextSettings) {
        return;
    }

    elements.saveSettingsBtn.disabled = true;
    if (elements.topbarSaveBtn) {
        elements.topbarSaveBtn.disabled = true;
        elements.topbarSaveBtn.textContent = '正在保存...';
    }
    elements.saveFeedback.textContent = '正在保存...';

    try {
        const savedSettings = await saveRuntimeSettings(nextSettings);
        state.settings = cloneSettings(savedSettings);
        state.settings = cloneSettings(await runRuntimeHealthCheck());
        markDirty(false);
        await refreshAssistantStatus();
        renderSettings();
    } catch (error) {
        elements.saveFeedback.textContent = error?.message || '保存失败';
    } finally {
        elements.saveSettingsBtn.disabled = false;
        if (elements.topbarSaveBtn) {
            elements.topbarSaveBtn.disabled = false;
            if (state.dirty) {
                elements.topbarSaveBtn.textContent = '保存配置';
            }
        }
    }
}

function bindFormInputs() {
    const inputBindings = [
        elements.petScaleInput,
        elements.cameraDistanceInput,
        elements.cameraTargetYInput,
        elements.petSkipTaskbarInput,
        elements.autoLaunchInput,
        elements.backendBaseUrlInput,
        elements.gatewayUrlInput,
        elements.voiceInputEnabledInput,
        elements.voiceOutputEnabledInput,
        elements.preferredMicInput
    ];

    inputBindings.forEach((input) => {
        const eventName =
            input.type === 'range' || input.type === 'text'
                ? 'input'
                : 'change';
        input.addEventListener(eventName, () => {
            const previewSettings = collectSettingsFromForm();
            if (!previewSettings) {
                return;
            }

            state.settings = previewSettings;
            renderSettings();
            markDirty(true);
        });
    });
}

function scrollToSection(sectionId) {
    const target = sectionElements.get(sectionId);
    if (!target || !elements.pageScroll) {
        return;
    }

    applyNavState(sectionId);
    elements.pageScroll.scrollTo({
        top: target.offsetTop - 18,
        behavior: 'smooth'
    });
}

function bindNavigation() {
    sectionTargets.forEach((button) => {
        button.addEventListener('click', () => {
            scrollToSection(button.dataset.target);
        });
    });
}

async function initialize() {
    state.settings = cloneSettings(await resolveRuntimeSettings());
    elements.editionGrid.replaceChildren(
        ...BACKEND_MODE_OPTIONS.map((option) => buildBackendModeCard(option))
    );

    bindNavigation();
    bindFormInputs();
    void refreshMicrophones();

    elements.assistantRefreshBtn?.addEventListener('click', async () => {
        elements.assistantRefreshBtn.disabled = true;
        elements.assistantStatusDetail.textContent = '正在重新检查当前后端状态...';
        try {
            state.settings = cloneSettings(await runRuntimeHealthCheck());
            await refreshAssistantStatus();
            renderSettings();
        } finally {
            elements.assistantRefreshBtn.disabled = false;
        }
    });

    elements.openSetupBtn?.addEventListener('click', () => {
        window.aigrilDesktop?.showSetupWindow?.();
    });
    elements.refreshMicsBtn?.addEventListener('click', () => {
        void refreshMicrophones({ requestPermission: true });
    });
    elements.saveSettingsBtn?.addEventListener('click', () => {
        void saveCurrentSettings();
    });
    elements.topbarSaveBtn?.addEventListener('click', () => {
        void saveCurrentSettings();
    });
    elements.closeBtn?.addEventListener('click', () => {
        void window.aigrilDesktop?.closeCurrentWindow?.();
    });

    subscribeRuntimeSettings((settings) => {
        state.settings = cloneSettings(settings);
        renderSettings();
        void refreshAssistantStatus();
    });

    navigator.mediaDevices?.addEventListener?.('devicechange', () => {
        void refreshMicrophones();
    });

    renderSettings();
    await refreshAssistantStatus();
    renderSettings();
    markDirty(false);
}

void initialize();
