const fs = require('fs');
const path = require('path');
const {
    resolveHumanClawFsLayout,
    resolveOpenClawHomeHints,
    resolveOpenClawRepoHints
} = require('./fs-layout.cjs');

const PROVIDER_OPTIONS = [
    {
        id: 'openrouter',
        label: 'OpenRouter',
        description: '一把 key 接多模型，适合先跑通助手版。',
        envVar: 'OPENROUTER_API_KEY',
        defaultModel: 'openrouter/auto',
        requiresApiKey: true,
        apiKeyPlaceholder: 'sk-or-...'
    },
    {
        id: 'openai',
        label: 'OpenAI API',
        description: '直接走 OpenAI Platform API。',
        envVar: 'OPENAI_API_KEY',
        defaultModel: 'openai/gpt-5.4',
        requiresApiKey: true,
        apiKeyPlaceholder: 'sk-...'
    },
    {
        id: 'openai-codex',
        label: 'OpenAI Codex',
        description: '复用 OpenClaw 里的 Codex 登录态，不单独写 API Key。',
        envVar: '',
        defaultModel: 'openai-codex/gpt-5.4',
        requiresApiKey: false,
        apiKeyPlaceholder: ''
    },
    {
        id: 'anthropic',
        label: 'Anthropic',
        description: 'Claude 路线，适合偏长思考和写作场景。',
        envVar: 'ANTHROPIC_API_KEY',
        defaultModel: 'anthropic/claude-sonnet-4-6',
        requiresApiKey: true,
        apiKeyPlaceholder: 'sk-ant-...'
    },
    {
        id: 'ollama',
        label: 'Ollama',
        description: '本地模型模式，会自动写入 ollama-local 标记。',
        envVar: 'OLLAMA_API_KEY',
        defaultModel: 'ollama/gemma4',
        requiresApiKey: false,
        apiKeyPlaceholder: ''
    }
];

const PROVIDER_BY_ID = new Map(PROVIDER_OPTIONS.map((provider) => [provider.id, provider]));

let cachedJson5 = null;

function normalizeOptionalString(value, fallback = '') {
    if (typeof value !== 'string') {
        return fallback;
    }

    const trimmed = value.trim();
    return trimmed || fallback;
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fileExists(targetPath) {
    try {
        return fs.existsSync(targetPath);
    } catch {
        return false;
    }
}

function ensureDirectory(targetPath) {
    fs.mkdirSync(targetPath, { recursive: true });
}

function getProviderById(providerId) {
    return PROVIDER_BY_ID.get(normalizeOptionalString(providerId, 'openrouter')) || PROVIDER_OPTIONS[0];
}

function inferProviderId(modelId, env = {}) {
    const normalizedModel = normalizeOptionalString(modelId).toLowerCase();
    if (normalizedModel.startsWith('openrouter/')) {
        return 'openrouter';
    }
    if (normalizedModel.startsWith('openai-codex/')) {
        return 'openai-codex';
    }
    if (normalizedModel.startsWith('openai/')) {
        return 'openai';
    }
    if (normalizedModel.startsWith('anthropic/')) {
        return 'anthropic';
    }
    if (normalizedModel.startsWith('ollama/')) {
        return 'ollama';
    }

    if (normalizeOptionalString(env.OPENROUTER_API_KEY)) {
        return 'openrouter';
    }
    if (normalizeOptionalString(env.OPENAI_API_KEY)) {
        return 'openai';
    }
    if (normalizeOptionalString(env.ANTHROPIC_API_KEY)) {
        return 'anthropic';
    }
    if (normalizeOptionalString(env.OLLAMA_API_KEY)) {
        return 'ollama';
    }

    return '';
}

function getDefaultAssistantProviderSettings(providerId = 'openrouter') {
    const provider = getProviderById(providerId);
    return {
        providerId: provider.id,
        modelId: provider.defaultModel,
        apiKey: '',
        clearApiKey: false,
        apiKeyPresent: false,
        apiKeyLabel: provider.requiresApiKey ? '未保存' : getProviderKeyHint(provider.id, false),
        configPath: '',
        configWritable: false
    };
}

function normalizeAssistantProviderSettings(input = {}) {
    const seed = isPlainObject(input) ? input : {};
    const inferredProviderId =
        normalizeOptionalString(seed.providerId) ||
        inferProviderId(seed.modelId, seed.env || {}) ||
        'openrouter';
    const defaults = getDefaultAssistantProviderSettings(inferredProviderId);

    return {
        ...defaults,
        ...seed,
        providerId: inferredProviderId,
        modelId: normalizeOptionalString(seed.modelId, defaults.modelId),
        apiKey: normalizeOptionalString(seed.apiKey),
        clearApiKey: Boolean(seed.clearApiKey),
        apiKeyPresent: Boolean(seed.apiKeyPresent),
        apiKeyLabel: normalizeOptionalString(seed.apiKeyLabel, defaults.apiKeyLabel),
        configPath: normalizeOptionalString(seed.configPath),
        configWritable: Boolean(seed.configWritable)
    };
}

function maskSecret(secret) {
    const normalized = normalizeOptionalString(secret);
    if (!normalized) {
        return '未保存';
    }

    if (normalized.length <= 10) {
        return `${normalized.slice(0, 3)}...`;
    }

    return `${normalized.slice(0, 4)}...${normalized.slice(-4)}`;
}

function getProviderKeyHint(providerId, apiKeyPresent, secret = '') {
    if (providerId === 'ollama') {
        return apiKeyPresent ? '已启用本地 Ollama' : '本地 Ollama 不需要 API Key';
    }
    if (providerId === 'openai-codex') {
        return '需要在 OpenClaw 里完成 Codex 登录';
    }
    if (apiKeyPresent) {
        return `已保存 ${maskSecret(secret)}`;
    }
    return '未保存';
}

function resolveOpenClawRuntimeRoot(options = {}) {
    const operatorSupervisor = options.operatorSupervisor;
    const appPath = options.appPath || process.cwd();
    const layout = resolveHumanClawFsLayout({
        installEdition:
            normalizeOptionalString(options.preferences?.installEdition) ||
            normalizeOptionalString(options.installEdition) ||
            undefined
    });
    const candidates = [
        normalizeOptionalString(operatorSupervisor?.bundleRoot),
        path.resolve(appPath, 'build-cache', 'openclaw-runtime'),
        path.resolve(appPath, '..', 'build-cache', 'openclaw-runtime'),
        ...resolveOpenClawRepoHints({
            layout,
            appPath
        })
    ];

    return (
        candidates.find((candidate) => (
            candidate &&
            fileExists(path.join(candidate, 'node_modules')) &&
            (fileExists(path.join(candidate, 'openclaw.mjs')) || fileExists(path.join(candidate, 'package.json')))
        )) || ''
    );
}

function loadJson5(runtimeRoot = '') {
    if (cachedJson5) {
        return cachedJson5;
    }

    const candidates = [
        runtimeRoot ? path.join(runtimeRoot, 'node_modules', 'json5') : '',
        runtimeRoot ? path.join(runtimeRoot, 'node_modules', 'json5', 'lib', 'index.js') : ''
    ].filter(Boolean);

    for (const candidate of candidates) {
        try {
            // eslint-disable-next-line global-require, import/no-dynamic-require
            cachedJson5 = require(candidate);
            return cachedJson5;
        } catch {}
    }

    return null;
}

function readConfigFile(configPath, runtimeRoot = '') {
    if (!configPath || !fileExists(configPath)) {
        return null;
    }

    const text = fs.readFileSync(configPath, 'utf8');
    if (!text.trim()) {
        return {};
    }

    const json5 = loadJson5(runtimeRoot);
    if (json5?.parse) {
        return json5.parse(text);
    }

    return JSON.parse(text);
}

function resolveConfiguredPath(rawPath) {
    const normalized = normalizeOptionalString(rawPath);
    if (!normalized) {
        return '';
    }

    if (normalized.toLowerCase().endsWith('.json')) {
        return normalized;
    }

    return path.join(normalized, 'openclaw.json');
}

function buildConfigLocation(homeRoot, preferNested = false) {
    const normalizedHome = normalizeOptionalString(homeRoot);
    if (!normalizedHome) {
        return '';
    }

    const directConfig = path.join(normalizedHome, 'openclaw.json');
    const nestedConfig = path.join(normalizedHome, '.openclaw', 'openclaw.json');

    if (fileExists(directConfig)) {
        return directConfig;
    }
    if (fileExists(nestedConfig)) {
        return nestedConfig;
    }
    if (preferNested || fileExists(path.join(normalizedHome, '.openclaw'))) {
        return nestedConfig;
    }
    if (fileExists(normalizedHome)) {
        return directConfig;
    }

    return '';
}

function resolveOpenClawConfigPath(options = {}) {
    const operatorSupervisor = options.operatorSupervisor;
    const layout = resolveHumanClawFsLayout({
        installEdition:
            normalizeOptionalString(options.preferences?.installEdition) ||
            normalizeOptionalString(options.installEdition) ||
            undefined
    });
    const explicitConfigPath = resolveConfiguredPath(process.env.OPENCLAW_CONFIG_PATH);
    if (explicitConfigPath) {
        return explicitConfigPath;
    }

    const explicitStateDir = normalizeOptionalString(process.env.OPENCLAW_STATE_DIR);
    if (explicitStateDir) {
        return path.join(explicitStateDir, 'openclaw.json');
    }

    const homeCandidates = resolveOpenClawHomeHints({
        layout,
        managedHomeRoot: normalizeOptionalString(operatorSupervisor?.managedHomeRoot)
    });

    for (const candidate of homeCandidates) {
        const resolved = buildConfigLocation(candidate.home, candidate.preferNested);
        if (resolved) {
            return resolved;
        }
    }

    return '';
}

function ensureConfigSkeleton(input = {}) {
    const nextConfig = isPlainObject(input) ? { ...input } : {};

    nextConfig.gateway = isPlainObject(nextConfig.gateway)
        ? { ...nextConfig.gateway }
        : {
            mode: 'local',
            bind: 'loopback'
        };
    nextConfig.agents = isPlainObject(nextConfig.agents) ? { ...nextConfig.agents } : {};
    nextConfig.agents.defaults = isPlainObject(nextConfig.agents.defaults)
        ? { ...nextConfig.agents.defaults }
        : {};
    nextConfig.agents.defaults.model = isPlainObject(nextConfig.agents.defaults.model)
        ? { ...nextConfig.agents.defaults.model }
        : {};
    nextConfig.env = isPlainObject(nextConfig.env) ? { ...nextConfig.env } : {};

    return nextConfig;
}

function buildProviderRuntimeState(config = {}, preferences = {}) {
    const stored = normalizeAssistantProviderSettings(preferences.assistantProvider || {});
    const configEnv = isPlainObject(config.env) ? config.env : {};
    const configuredModelId = normalizeOptionalString(config.agents?.defaults?.model?.primary);
    const resolvedProviderId =
        inferProviderId(configuredModelId, configEnv) ||
        normalizeOptionalString(stored.providerId) ||
        'openrouter';
    const provider = getProviderById(resolvedProviderId);
    const modelId = configuredModelId || stored.modelId || provider.defaultModel;
    const secret = provider.envVar ? normalizeOptionalString(configEnv[provider.envVar]) : '';
    const apiKeyPresent = provider.id === 'ollama'
        ? normalizeOptionalString(configEnv.OLLAMA_API_KEY) === 'ollama-local'
        : Boolean(secret);

    return normalizeAssistantProviderSettings({
        providerId: provider.id,
        modelId,
        apiKeyPresent,
        apiKeyLabel: getProviderKeyHint(provider.id, apiKeyPresent, secret)
    });
}

function readOpenClawProviderRuntimeState(options = {}) {
    const preferences = options.preferences || {};
    const runtimeRoot = resolveOpenClawRuntimeRoot(options);
    const configPath = resolveOpenClawConfigPath(options);

    try {
        const config = readConfigFile(configPath, runtimeRoot) || {};
        return normalizeAssistantProviderSettings({
            ...buildProviderRuntimeState(config, preferences),
            configPath,
            configWritable: Boolean(configPath)
        });
    } catch (error) {
        const fallback = normalizeAssistantProviderSettings(preferences.assistantProvider || {});
        return normalizeAssistantProviderSettings({
            ...fallback,
            apiKeyPresent: false,
            apiKeyLabel: `读取失败：${error instanceof Error ? error.message : String(error)}`,
            configPath,
            configWritable: Boolean(configPath)
        });
    }
}

function applyOpenClawProviderSettings(options = {}) {
    const preferences = options.preferences || {};
    const providerPatch = options.providerPatch || {};
    const runtimeRoot = resolveOpenClawRuntimeRoot(options);
    const configPath = resolveOpenClawConfigPath(options);
    const baseState = readOpenClawProviderRuntimeState(options);
    const draftState = normalizeAssistantProviderSettings({
        ...baseState,
        ...providerPatch
    });
    const provider = getProviderById(draftState.providerId);
    const nextModelId = normalizeOptionalString(draftState.modelId, provider.defaultModel);

    if (!configPath) {
        return normalizeAssistantProviderSettings({
            providerId: provider.id,
            modelId: nextModelId,
            apiKeyPresent: false,
            apiKeyLabel: '未检测到 OpenClaw 配置目录，provider 已保存在桌宠参数里',
            configPath: '',
            configWritable: false
        });
    }

    let config = {};
    try {
        config = ensureConfigSkeleton(readConfigFile(configPath, runtimeRoot) || {});
    } catch {
        config = ensureConfigSkeleton({});
    }

    config.agents.defaults.model.primary = nextModelId;

    if (provider.id === 'ollama') {
        config.env.OLLAMA_API_KEY = 'ollama-local';
    } else if (provider.envVar) {
        const nextSecret = normalizeOptionalString(providerPatch.apiKey);
        if (nextSecret) {
            config.env[provider.envVar] = nextSecret;
        } else if (providerPatch.clearApiKey) {
            delete config.env[provider.envVar];
        }
    }

    ensureDirectory(path.dirname(configPath));
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    return readOpenClawProviderRuntimeState({
        ...options,
        preferences: {
            ...preferences,
            assistantProvider: {
                providerId: provider.id,
                modelId: nextModelId
            }
        }
    });
}

module.exports = {
    PROVIDER_OPTIONS,
    applyOpenClawProviderSettings,
    getDefaultAssistantProviderSettings,
    getProviderById,
    normalizeAssistantProviderSettings,
    readOpenClawProviderRuntimeState,
    resolveOpenClawConfigPath,
    resolveOpenClawRuntimeRoot
};
