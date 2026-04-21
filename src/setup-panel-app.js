import {
    BACKEND_MODE_OPTIONS,
    completeRuntimeOnboarding,
    getBackendModeById,
    normalizeRuntimeSettings,
    resolveRuntimeSettings,
    runRuntimeHealthCheck,
    saveRuntimeSettings,
    subscribeRuntimeSettings
} from './runtime-settings.js';

const steps = Array.from(document.querySelectorAll('.progress-step'));
const panels = Array.from(document.querySelectorAll('.step-panel'));

const state = {
    stepIndex: 0,
    settings: null
};

const elements = {
    editionGrid: document.getElementById('setup-edition-grid'),
    petScaleInput: document.getElementById('setup-pet-scale-input'),
    petScaleValue: document.getElementById('setup-pet-scale-value'),
    cameraDistanceInput: document.getElementById('setup-camera-distance-input'),
    cameraDistanceValue: document.getElementById('setup-camera-distance-value'),
    cameraTargetYInput: document.getElementById('setup-camera-target-y-input'),
    cameraTargetYValue: document.getElementById('setup-camera-target-y-value'),
    autoLaunchInput: document.getElementById('setup-auto-launch-input'),
    petTaskbarInput: document.getElementById('setup-pet-taskbar-input'),
    voiceInputInput: document.getElementById('setup-voice-input-input'),
    voiceOutputInput: document.getElementById('setup-voice-output-input'),
    backendBaseUrlInput: document.getElementById('setup-backend-base-url-input'),
    gatewayUrlInput: document.getElementById('setup-gateway-url-input'),
    assistantStatusPill: document.getElementById('setup-assistant-status-pill'),
    assistantStatusDetail: document.getElementById('setup-assistant-status-detail'),
    healthCheckBtn: document.getElementById('setup-health-check-btn'),
    backBtn: document.getElementById('setup-back-btn'),
    nextBtn: document.getElementById('setup-next-btn'),
    finishBtn: document.getElementById('setup-finish-btn'),
    closeBtn: document.getElementById('setup-close-btn'),
    summaryEdition: document.getElementById('summary-edition'),
    summaryEditionCopy: document.getElementById('summary-edition-copy'),
    summaryAvatarList: document.getElementById('summary-avatar-list'),
    summarySafetyList: document.getElementById('summary-safety-list'),
    summaryProvider: document.getElementById('summary-provider'),
    summaryConnectivity: document.getElementById('summary-connectivity'),
    footerHint: document.getElementById('footer-hint')
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

function collectSettingsFromForm() {
    if (!state.settings) {
        return null;
    }

    return cloneSettings({
        ...state.settings,
        petScale: Number(elements.petScaleInput.value),
        cameraDistance: Number(elements.cameraDistanceInput.value),
        cameraTargetY: Number(elements.cameraTargetYInput.value),
        autoLaunchOnLogin: elements.autoLaunchInput.checked,
        petSkipTaskbar: !elements.petTaskbarInput.checked,
        voiceInputEnabled: elements.voiceInputInput.checked,
        voiceOutputEnabled: elements.voiceOutputInput.checked,
        backendBaseUrl: String(elements.backendBaseUrlInput.value || '').trim(),
        openclawGatewayUrl: String(elements.gatewayUrlInput.value || '').trim()
    });
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
        syncFormFromState();
        renderSummary();
    });
    return button;
}

function renderStep() {
    steps.forEach((step, index) => {
        step.classList.toggle('is-active', index === state.stepIndex);
    });
    panels.forEach((panel, index) => {
        panel.classList.toggle('is-active', index === state.stepIndex);
    });

    elements.backBtn.disabled = state.stepIndex === 0;
    elements.nextBtn.hidden = state.stepIndex === panels.length - 1;
    elements.finishBtn.hidden = state.stepIndex !== panels.length - 1;

    const stepHints = [
        '先决定这台机器的对话主后端，是陪伴服务还是你自己安装的本地 OpenClaw。',
        '现在调的是人物体感和语音开关，后面桌宠会直接按这套参数启动。',
        '最后把两个地址定稳，再确认当前机器有没有已经跑起来的 OpenClaw。'
    ];
    elements.footerHint.textContent = stepHints[state.stepIndex] || '';
}

function renderAssistantHealth(settings = state.settings) {
    const health = settings?.assistantHealth;

    if (!health) {
        elements.assistantStatusPill.textContent = '等待健康检查';
        elements.assistantStatusPill.className = 'status-pill is-warning';
        elements.assistantStatusDetail.textContent = '保存当前选择后，可直接检查本机 OpenClaw Gateway 是否已经打通。';
        return;
    }

    if (settings.backendMode === 'companion-service' || health.status === 'service') {
        elements.assistantStatusPill.textContent = '当前走陪伴后端';
        elements.assistantStatusPill.className = 'status-pill is-warning';
        elements.assistantStatusDetail.textContent =
            health.reason ||
            `HumanClaw 会把对话交给 ${settings.backendBaseUrl}，不会接管 OpenClaw 的安装和配置。`;
        return;
    }

    if (health.status === 'ready') {
        elements.assistantStatusPill.textContent = 'OpenClaw 已就绪';
        elements.assistantStatusPill.className = 'status-pill is-online';
        elements.assistantStatusDetail.textContent = health.reason || '当前可以直接走本地 OpenClaw。';
        return;
    }

    if (health.status === 'checking') {
        elements.assistantStatusPill.textContent = '正在检查中';
        elements.assistantStatusPill.className = 'status-pill is-warning';
        elements.assistantStatusDetail.textContent = health.reason || '正在检查本机 OpenClaw 与 Gateway。';
        return;
    }

    elements.assistantStatusPill.textContent = 'OpenClaw 未连接';
    elements.assistantStatusPill.className = 'status-pill is-offline';
    elements.assistantStatusDetail.textContent = [health.reason, health.hint].filter(Boolean).join(' ');
}

function syncFormFromState() {
    const settings = state.settings;
    if (!settings) {
        return;
    }

    elements.petScaleInput.value = String(settings.petScale);
    elements.petScaleValue.textContent = formatScale(settings.petScale);
    elements.cameraDistanceInput.value = String(settings.cameraDistance);
    elements.cameraDistanceValue.textContent = formatDistance(settings.cameraDistance);
    elements.cameraTargetYInput.value = String(settings.cameraTargetY);
    elements.cameraTargetYValue.textContent = formatHeight(settings.cameraTargetY);
    elements.autoLaunchInput.checked = Boolean(settings.autoLaunchOnLogin);
    elements.petTaskbarInput.checked = !settings.petSkipTaskbar;
    elements.voiceInputInput.checked = Boolean(settings.voiceInputEnabled);
    elements.voiceOutputInput.checked = Boolean(settings.voiceOutputEnabled);
    elements.backendBaseUrlInput.value = settings.backendBaseUrl || '';
    elements.gatewayUrlInput.value = settings.openclawGatewayUrl || '';
    renderAssistantHealth(settings);

    Array.from(elements.editionGrid.children).forEach((card) => {
        card.classList.toggle('is-selected', card.dataset.backendModeId === settings.backendMode);
    });
}

function renderSummary() {
    const settings = collectSettingsFromForm();
    if (!settings) {
        return;
    }

    state.settings = settings;
    const mode = getBackendModeById(settings.backendMode);
    const avatarSummary = [
        `人物缩放 ${formatScale(settings.petScale)}，镜头距离 ${formatDistance(settings.cameraDistance)}。`,
        `视线中心高度 ${formatHeight(settings.cameraTargetY)}，${settings.petSkipTaskbar ? '默认不在任务栏占位' : '默认保留任务栏入口'}。`,
        `${settings.voiceInputEnabled ? '保留本地语音识别' : '关闭本地语音识别'}，${settings.voiceOutputEnabled ? '保留本地播报' : '关闭本地播报'}。`
    ];

    const safetySummary = settings.backendMode === 'openclaw-local'
        ? [
            'HumanClaw 只负责连接本地 OpenClaw Gateway。',
            'OpenClaw 的 provider、模型、权限策略都由你在 OpenClaw 自己那边维护。',
            '如果本机 Gateway 没起，HumanClaw 不会代你安装或修复。'
        ]
        : [
            '所有对话直接走陪伴后端服务。',
            '更偏桌宠、聊天和轻量语音，不主动依赖本地 OpenClaw。',
            '后面随时都能去控制面板切到本地 OpenClaw 模式。'
        ];

    elements.summaryEdition.textContent = mode.label;
    elements.summaryEditionCopy.textContent = mode.description;
    elements.summaryProvider.textContent = settings.backendMode === 'openclaw-local'
        ? `本地 OpenClaw / ${settings.openclawGatewayUrl}`
        : `陪伴后端 / ${settings.backendBaseUrl}`;
    elements.summaryAvatarList.replaceChildren(
        ...avatarSummary.map((text) => {
            const item = document.createElement('li');
            item.textContent = text;
            return item;
        })
    );
    elements.summarySafetyList.replaceChildren(
        ...safetySummary.map((text) => {
            const item = document.createElement('li');
            item.textContent = text;
            return item;
        })
    );

    if (settings.backendMode === 'companion-service') {
        elements.summaryConnectivity.textContent = `默认把对话发给 ${settings.backendBaseUrl}。如果后面你自己装好了 OpenClaw，再切回本地 OpenClaw 模式即可。`;
    } else {
        const healthCopy = settings.assistantHealth?.ready
            ? '当前健康检查通过，聊天会直接进入 OpenClaw 助手链路。'
            : settings.assistantHealth?.reason
                ? settings.assistantHealth.reason
                : '如果本机 Gateway 没跑起来，聊天会自动退回陪伴后端。';
        elements.summaryConnectivity.textContent = `优先连接 ${settings.openclawGatewayUrl}，连接不上时回退到 ${settings.backendBaseUrl}。${healthCopy}`;
    }
}

function bindFormUpdates() {
    const inputs = [
        elements.petScaleInput,
        elements.cameraDistanceInput,
        elements.cameraTargetYInput,
        elements.autoLaunchInput,
        elements.petTaskbarInput,
        elements.voiceInputInput,
        elements.voiceOutputInput,
        elements.backendBaseUrlInput,
        elements.gatewayUrlInput
    ];

    inputs.forEach((input) => {
        const eventName =
            input.type === 'range' || input.type === 'text'
                ? 'input'
                : 'change';
        input.addEventListener(eventName, () => {
            const nextSettings = collectSettingsFromForm();
            if (!nextSettings) {
                return;
            }
            state.settings = nextSettings;
            syncFormFromState();
            renderSummary();
        });
    });
}

async function finishSetup() {
    const payload = collectSettingsFromForm();
    if (!payload) {
        return;
    }

    elements.finishBtn.disabled = true;
    elements.finishBtn.textContent = '正在应用...';

    try {
        state.settings = cloneSettings(await completeRuntimeOnboarding(payload));
        renderAssistantHealth(state.settings);
        await window.aigrilDesktop?.closeCurrentWindow?.();
    } catch (error) {
        elements.footerHint.textContent = error?.message || '首启配置失败';
    } finally {
        elements.finishBtn.disabled = false;
        elements.finishBtn.textContent = '完成配置';
    }
}

async function runHealthCheckWithCurrentSettings() {
    const payload = collectSettingsFromForm();
    if (!payload) {
        return;
    }

    elements.healthCheckBtn.disabled = true;
    elements.footerHint.textContent = '正在检查当前后端状态...';

    try {
        state.settings = cloneSettings(await saveRuntimeSettings(payload));
        state.settings = cloneSettings(await runRuntimeHealthCheck());
        renderAssistantHealth(state.settings);
        renderSummary();
        elements.footerHint.textContent = state.settings.assistantHealth?.ready
            ? '健康检查通过，当前机器已经可以直接走本地 OpenClaw。'
            : '健康检查已完成，可以继续保留当前模式，或者改完地址后再查一次。';
    } catch (error) {
        elements.footerHint.textContent = error?.message || '健康检查失败';
    } finally {
        elements.healthCheckBtn.disabled = false;
    }
}

async function initialize() {
    state.settings = cloneSettings(await resolveRuntimeSettings());
    elements.editionGrid.replaceChildren(
        ...BACKEND_MODE_OPTIONS.map((option) => buildBackendModeCard(option))
    );

    syncFormFromState();
    renderSummary();
    renderStep();
    bindFormUpdates();

    elements.backBtn.addEventListener('click', () => {
        state.stepIndex = Math.max(0, state.stepIndex - 1);
        renderStep();
    });

    elements.nextBtn.addEventListener('click', () => {
        state.stepIndex = Math.min(panels.length - 1, state.stepIndex + 1);
        renderSummary();
        renderStep();
    });

    elements.finishBtn.addEventListener('click', () => {
        void finishSetup();
    });

    elements.healthCheckBtn.addEventListener('click', () => {
        void runHealthCheckWithCurrentSettings();
    });

    elements.closeBtn?.addEventListener('click', () => {
        void window.aigrilDesktop?.closeCurrentWindow?.();
    });

    subscribeRuntimeSettings((settings) => {
        state.settings = cloneSettings(settings);
        syncFormFromState();
        renderSummary();
    });
}

void initialize();
