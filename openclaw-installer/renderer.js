const STEP_DEFS = [
    { id: 'prepare-runtime', label: '准备 Runtime' },
    { id: 'doctor', label: '修复基础配置' },
    { id: 'start-gateway', label: '启动 Gateway' },
    { id: 'probe-gateway', label: '验证 Gateway' },
    { id: 'provider-ready', label: '配置模型 Provider' }
];

const STEP_STATE_LABELS = {
    pending: '待处理',
    active: '进行中',
    done: '完成'
};

const elements = {
    heroSummary: document.getElementById('hero-summary'),
    statusChip: document.getElementById('status-chip'),
    providerChip: document.getElementById('provider-chip'),
    activityTitle: document.getElementById('activity-title'),
    activityDetail: document.getElementById('activity-detail'),
    progressFill: document.getElementById('progress-fill'),
    stepList: document.getElementById('step-list'),
    startBtn: document.getElementById('start-btn'),
    restartBtn: document.getElementById('restart-btn'),
    stopBtn: document.getElementById('stop-btn'),
    openHomeBtn: document.getElementById('open-home-btn'),
    openLogsBtn: document.getElementById('open-logs-btn'),
    setupSummary: document.getElementById('setup-summary'),
    providerSelect: document.getElementById('provider-select'),
    baseUrlField: document.getElementById('base-url-field'),
    baseUrlInput: document.getElementById('base-url-input'),
    customProviderField: document.getElementById('custom-provider-field'),
    customProviderInput: document.getElementById('custom-provider-input'),
    modelLabel: document.getElementById('model-label'),
    modelInput: document.getElementById('model-input'),
    modelSuggestions: document.getElementById('model-suggestions'),
    apiKeyInput: document.getElementById('api-key-input'),
    apiKeyHint: document.getElementById('api-key-hint'),
    saveProviderBtn: document.getElementById('save-provider-btn'),
    refreshStatusBtn: document.getElementById('refresh-status-btn'),
    useCurrentBtn: document.getElementById('use-current-btn'),
    setupForm: document.getElementById('setup-form'),
    configState: document.getElementById('config-state'),
    infoGrid: document.getElementById('info-grid')
};

let currentStatus = null;
let seededForm = false;

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatDateTime(value) {
    if (!value) {
        return '未记录';
    }

    try {
        return new Date(value).toLocaleString('zh-CN', { hour12: false });
    } catch {
        return '未记录';
    }
}

function getProviderCatalog(status) {
    return Array.isArray(status?.providerCatalog) ? status.providerCatalog : [];
}

function findSelectedProvider(status) {
    const providerId = elements.providerSelect.value;
    return getProviderCatalog(status).find((entry) => entry.id === providerId) || null;
}

function computeProgress(status) {
    const activity = status?.activity || {};
    if (Number.isFinite(activity.percent) && activity.percent > 0) {
        return Math.max(0, Math.min(100, activity.percent));
    }

    if (status?.running && status?.providerSetup?.configured) {
        return 100;
    }

    if (status?.running) {
        return 82;
    }

    return 0;
}

function statusChipMeta(status) {
    const health = status?.health || 'idle';
    const activityPhase = status?.activity?.phase || '';

    if (health === 'running') {
        return { label: 'Runtime 已就绪', tone: 'good' };
    }
    if (health === 'error' || activityPhase === 'error') {
        return { label: '需要处理', tone: 'bad' };
    }
    if (health === 'bootstrapping' || health === 'repairing' || health === 'configuring') {
        return { label: '正在处理', tone: 'warn' };
    }
    if (health === 'stopped') {
        return { label: 'Gateway 已停止', tone: 'warn' };
    }

    return { label: '待机', tone: '' };
}

function providerChipMeta(status) {
    const setup = status?.providerSetup || {};
    if (setup.configured) {
        return {
            label: `${setup.providerLabel} / ${setup.defaultModel || '已配置'}`,
            tone: 'good'
        };
    }

    return {
        label: 'Provider 未配置',
        tone: 'warn'
    };
}

function getStepIndex(status) {
    const phase = status?.activity?.phase || '';
    const setupConfigured = Boolean(status?.providerSetup?.configured);

    switch (phase) {
        case 'prepare-runtime':
            return 0;
        case 'doctor':
        case 'repair-runtime':
            return 1;
        case 'start-gateway':
            return 2;
        case 'probe-gateway':
            return 3;
        case 'provider-config':
        case 'provider-ready':
            return 4;
        default:
            if (status?.running && !setupConfigured) {
                return 4;
            }
            if (status?.running && setupConfigured) {
                return STEP_DEFS.length;
            }
            return -1;
    }
}

function renderStepList(status) {
    const activeIndex = getStepIndex(status);
    const providerConfigured = Boolean(status?.providerSetup?.configured);

    elements.stepList.innerHTML = STEP_DEFS.map((step, index) => {
        let state = 'pending';

        if (index < activeIndex) {
            state = 'done';
        } else if (index === activeIndex) {
            state = 'active';
        }

        if (step.id === 'provider-ready' && providerConfigured) {
            state = 'done';
        }

        if (status?.running && providerConfigured) {
            state = 'done';
        }

        return `
            <div class="step-row ${state}">
                <div class="step-dot"></div>
                <div class="step-label">${escapeHtml(step.label)}</div>
                <div class="step-state">${escapeHtml(STEP_STATE_LABELS[state])}</div>
            </div>
        `;
    }).join('');
}

function renderProviderOptions(status) {
    const catalog = getProviderCatalog(status);
    const existingIds = new Set(Array.from(elements.providerSelect.options).map((option) => option.value));
    if (catalog.length === 0 || existingIds.size === catalog.length) {
        return;
    }

    elements.providerSelect.innerHTML = catalog
        .map((entry) => `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.label)}</option>`)
        .join('');
}

function renderModelSuggestions(status) {
    const preset = findSelectedProvider(status);
    const suggestions = Array.isArray(preset?.modelSuggestions) ? preset.modelSuggestions : [];
    elements.modelSuggestions.innerHTML = suggestions
        .map((value) => `<option value="${escapeHtml(value)}"></option>`)
        .join('');
}

function renderProviderFields(status) {
    const preset = findSelectedProvider(status);
    const custom = Boolean(preset?.custom);

    elements.baseUrlField.hidden = !custom;
    elements.customProviderField.hidden = !custom;
    elements.modelLabel.textContent = custom ? '模型 ID' : '默认模型';
    elements.modelInput.placeholder = preset?.modelPlaceholder || '';
    elements.baseUrlInput.placeholder = preset?.baseUrlPlaceholder || 'https://api.example.com/v1';
    elements.customProviderInput.placeholder = preset?.providerIdPlaceholder || 'custom';

    if (custom) {
        elements.apiKeyHint.textContent = '会写入 models.providers.<providerId>.apiKey，留空会保留现有值。';
        elements.heroSummary.textContent = '这个首启页会完成本地 Runtime 准备、Gateway 拉起、健康检查和 Provider 首配。自定义 Provider 会写进 OpenClaw 的 models.providers，并在 Runtime 内部接管。';
    } else {
        const envVar = preset?.envVar || '对应 Provider 的 key';
        elements.apiKeyHint.textContent = `会写入 openclaw.json -> env.vars.${envVar}，留空会保留现有值。`;
        elements.heroSummary.textContent = '这个首启页会完成本地 Runtime 准备、Gateway 拉起、健康检查和 Provider 首配。装完以后，别的前端直接连 ws://127.0.0.1:19011 就能用。';
    }

    renderModelSuggestions(status);
}

function seedFormFromStatus(status, force = false) {
    if (!status) {
        return;
    }

    if (seededForm && !force) {
        return;
    }

    const setup = status.providerSetup || {};
    const catalog = getProviderCatalog(status);
    const selectedId = setup.providerKind === 'custom'
        ? 'custom-openai'
        : catalog.some((entry) => entry.id === setup.providerId)
            ? setup.providerId
            : catalog[0]?.id;

    if (selectedId) {
        elements.providerSelect.value = selectedId;
    }

    renderProviderFields(status);

    if (setup.providerKind === 'custom') {
        elements.customProviderInput.value = setup.providerId || '';
        elements.baseUrlInput.value = setup.baseUrl || '';
        elements.modelInput.value = setup.modelName || '';
    } else {
        elements.customProviderInput.value = '';
        elements.baseUrlInput.value = '';
        elements.modelInput.value = setup.defaultModel || (findSelectedProvider(status)?.defaultModel || '');
    }

    elements.apiKeyInput.value = '';
    seededForm = true;
}

function renderSetupSummary(status) {
    const setup = status?.providerSetup || {};
    const providerLabel = setup.providerLabel || '未配置';

    if (setup.configured) {
        const pieces = [
            `当前默认 Provider 是 ${providerLabel}`,
            setup.defaultModel ? `默认模型是 ${setup.defaultModel}` : '',
            setup.baseUrl ? `Base URL: ${setup.baseUrl}` : '',
            setup.lastConfiguredAt ? `最近写入时间 ${formatDateTime(setup.lastConfiguredAt)}` : ''
        ].filter(Boolean);
        elements.setupSummary.textContent = pieces.join('，');
        return;
    }

    if (status?.running) {
        elements.setupSummary.textContent = 'Runtime 已经跑起来了，下一步把 Provider 和默认模型写进去。';
        return;
    }

    elements.setupSummary.textContent = '先等 Runtime 基础环境准备好，再写入 Provider 配置。';
}

function renderInfoRows(status) {
    const setup = status?.providerSetup || {};
    const rows = [
        ['Gateway 地址', status?.gatewayUrl || 'ws://127.0.0.1:19011'],
        ['Runtime 目录', status?.bundleRoot || '未找到'],
        ['OpenClaw Home', status?.openClawHome || '未初始化'],
        ['配置文件', setup.configPath || status?.configPath || '未生成'],
        ['模型索引', setup.modelsPath || status?.modelsPath || '未生成'],
        ['当前 Provider', setup.providerLabel || '未配置'],
        ['当前默认模型', setup.defaultModel || '未配置'],
        ['最近启动', formatDateTime(status?.lastStartedAt)],
        ['日志目录', status?.logsDir || '未初始化']
    ];

    elements.infoGrid.innerHTML = rows.map(([label, value]) => `
        <div class="info-block">
            <div class="info-label">${escapeHtml(label)}</div>
            <div class="info-value">${escapeHtml(value)}</div>
        </div>
    `).join('');
}

function applyChip(element, meta) {
    element.textContent = meta.label;
    element.className = `chip ${meta.tone}`.trim();
}

function renderStatus(status) {
    currentStatus = status;
    renderProviderOptions(status);
    renderProviderFields(status);
    if (!seededForm) {
        seedFormFromStatus(status, true);
    }

    const statusMeta = statusChipMeta(status);
    const providerMeta = providerChipMeta(status);
    const progress = computeProgress(status);
    const activity = status?.activity || {};
    const setupConfigured = Boolean(status?.providerSetup?.configured);
    const busy = ['prepare-runtime', 'doctor', 'repair-runtime', 'start-gateway', 'probe-gateway', 'provider-config'].includes(activity.phase)
        || ['bootstrapping', 'repairing', 'configuring'].includes(status?.health);

    applyChip(elements.statusChip, statusMeta);
    applyChip(elements.providerChip, providerMeta);
    elements.activityTitle.textContent = activity.label || '等待开始';
    elements.activityDetail.textContent = activity.detail || status?.lastError || '正在读取当前状态。';
    elements.progressFill.style.width = `${progress}%`;
    elements.configState.textContent = status?.lastError
        ? `最近错误：${status.lastError}`
        : setupConfigured
            ? 'Provider 和 Runtime 都已经有状态了。'
            : 'Provider 还没配，Runtime 可以先跑起来。';

    renderStepList(status);
    renderSetupSummary(status);
    renderInfoRows(status);

    elements.startBtn.disabled = !status?.bundleReady || Boolean(status?.running) || busy;
    elements.restartBtn.disabled = !status?.bundleReady || busy;
    elements.stopBtn.disabled = !status?.running || busy;
    elements.openHomeBtn.disabled = !status?.openClawHome;
    elements.openLogsBtn.disabled = !status?.logsDir;
    elements.saveProviderBtn.disabled = !status?.bundleReady || busy;
    elements.refreshStatusBtn.disabled = busy;
    elements.useCurrentBtn.disabled = busy;
    elements.providerSelect.disabled = busy;
    elements.baseUrlInput.disabled = busy;
    elements.customProviderInput.disabled = busy;
    elements.modelInput.disabled = busy;
    elements.apiKeyInput.disabled = busy;
}

async function withButton(button, busyText, action) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = busyText;

    try {
        const status = await action();
        if (status) {
            renderStatus(status);
        }
    } catch (error) {
        const latest = await window.openclawRuntime.getStatus().catch(() => null);
        if (latest) {
            renderStatus({
                ...latest,
                lastError: error?.message || '执行失败'
            });
        }
    } finally {
        button.textContent = original;
    }
}

function buildProviderPayload(status) {
    const preset = findSelectedProvider(status);
    if (!preset) {
        throw new Error('请先选择 Provider。');
    }

    const payload = {
        providerId: preset.id,
        apiKey: elements.apiKeyInput.value.trim()
    };

    if (preset.custom) {
        payload.baseUrl = elements.baseUrlInput.value.trim();
        payload.customProviderId = elements.customProviderInput.value.trim();
        payload.customModelName = elements.modelInput.value.trim();
    } else {
        payload.model = elements.modelInput.value.trim();
    }

    return payload;
}

window.addEventListener('DOMContentLoaded', async () => {
    const initialStatus = await window.openclawRuntime.getStatus();
    renderStatus(initialStatus);
    seedFormFromStatus(initialStatus, true);

    const unsubscribe = window.openclawRuntime.onStatus((status) => {
        renderStatus(status);
    });

    elements.providerSelect.addEventListener('change', () => {
        renderProviderFields(currentStatus);
        const preset = findSelectedProvider(currentStatus);
        if (preset?.custom) {
            if (!elements.customProviderInput.value) {
                elements.customProviderInput.value = preset.defaultProviderId || '';
            }
            if (!elements.modelInput.value) {
                elements.modelInput.value = preset.defaultModelName || '';
            }
        } else if (!elements.modelInput.value) {
            elements.modelInput.value = preset?.defaultModel || '';
        }
    });

    elements.startBtn.addEventListener('click', () => {
        void withButton(elements.startBtn, '启动中...', () => window.openclawRuntime.start());
    });
    elements.restartBtn.addEventListener('click', () => {
        void withButton(elements.restartBtn, '重启中...', () => window.openclawRuntime.restart());
    });
    elements.stopBtn.addEventListener('click', () => {
        void withButton(elements.stopBtn, '停止中...', () => window.openclawRuntime.stop());
    });
    elements.openHomeBtn.addEventListener('click', () => {
        void window.openclawRuntime.openHome();
    });
    elements.openLogsBtn.addEventListener('click', () => {
        void window.openclawRuntime.openLogs();
    });
    elements.refreshStatusBtn.addEventListener('click', () => {
        void withButton(elements.refreshStatusBtn, '刷新中...', () => window.openclawRuntime.getStatus());
    });
    elements.useCurrentBtn.addEventListener('click', () => {
        seededForm = false;
        seedFormFromStatus(currentStatus, true);
    });

    elements.setupForm.addEventListener('submit', (event) => {
        event.preventDefault();

        void withButton(elements.saveProviderBtn, '保存中...', async () => {
            const payload = buildProviderPayload(currentStatus);
            const status = await window.openclawRuntime.configureProvider(payload);
            elements.apiKeyInput.value = '';
            seededForm = false;
            seedFormFromStatus(status, true);
            return status;
        });
    });

    window.addEventListener('beforeunload', () => {
        unsubscribe();
    });
});
