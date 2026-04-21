const { EventEmitter } = require('events');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { OpenClawGatewayManager } = require('../electron/openclaw-gateway.cjs');

const DEFAULT_GATEWAY_URL = 'ws://127.0.0.1:19011';
const DEFAULT_GATEWAY_PORT = 19011;
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 180000;
const DEFAULT_MODEL_CONTEXT_WINDOW = 128000;
const DEFAULT_MODEL_MAX_TOKENS = 16384;
const REQUIRED_RUNTIME_PACKAGES = [
    'tslog',
    'ws',
    'zod'
];

const PROVIDER_PRESETS = [
    {
        id: 'openrouter',
        label: 'OpenRouter',
        description: '一把 key 先把多家模型接进来，最省事。',
        alias: 'OpenRouter',
        envVar: 'OPENROUTER_API_KEY',
        defaultModel: 'openrouter/auto',
        modelPlaceholder: 'openrouter/auto',
        modelSuggestions: [
            'openrouter/auto',
            'openrouter/google/gemini-2.5-pro',
            'openrouter/anthropic/claude-sonnet-4.6'
        ]
    },
    {
        id: 'openai',
        label: 'OpenAI',
        description: '直接接 OpenAI 官方模型。',
        alias: 'GPT',
        envVar: 'OPENAI_API_KEY',
        defaultModel: 'openai/gpt-5.4',
        modelPlaceholder: 'openai/gpt-5.4',
        modelSuggestions: [
            'openai/gpt-5.4',
            'openai/gpt-5.4-mini',
            'openai/gpt-5.2'
        ]
    },
    {
        id: 'anthropic',
        label: 'Anthropic',
        description: 'Claude 系列，适合长上下文和高质量推理。',
        alias: 'Claude',
        envVar: 'ANTHROPIC_API_KEY',
        defaultModel: 'anthropic/claude-sonnet-4-6',
        modelPlaceholder: 'anthropic/claude-sonnet-4-6',
        modelSuggestions: [
            'anthropic/claude-sonnet-4-6',
            'anthropic/claude-opus-4-6',
            'anthropic/claude-haiku-4-5'
        ]
    },
    {
        id: 'google',
        label: 'Google Gemini',
        description: 'Gemini 系列，多模态和大上下文都不错。',
        alias: 'Gemini',
        envVar: 'GEMINI_API_KEY',
        defaultModel: 'google/gemini-2.5-pro',
        modelPlaceholder: 'google/gemini-2.5-pro',
        modelSuggestions: [
            'google/gemini-2.5-pro',
            'google/gemini-2.5-flash',
            'google/gemini-3.1-pro-preview'
        ]
    },
    {
        id: 'custom-openai',
        label: 'Custom (OpenAI-compatible)',
        description: '接你自己的网关、代理或本地兼容 /v1 服务。',
        alias: 'Custom',
        custom: true,
        defaultProviderId: 'custom',
        defaultModelName: 'gpt-4o-mini',
        baseUrlPlaceholder: 'https://api.example.com/v1',
        providerIdPlaceholder: 'mygateway',
        modelPlaceholder: 'gpt-4o-mini',
        modelSuggestions: [
            'gpt-4o-mini',
            'qwen3-coder',
            'deepseek-chat'
        ]
    }
];

const PROVIDER_PRESET_MAP = new Map(PROVIDER_PRESETS.map((preset) => [preset.id, preset]));

function normalizeOptionalString(value, fallback = '') {
    if (typeof value !== 'string') {
        return fallback;
    }

    const trimmed = value.trim();
    return trimmed || fallback;
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

function ensureObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }

    return value;
}

function safeParseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function readJsonIfExists(targetPath) {
    if (!targetPath || !fileExists(targetPath)) {
        return null;
    }

    try {
        return safeParseJson(fs.readFileSync(targetPath, 'utf8'));
    } catch {
        return null;
    }
}

function writeJsonFile(targetPath, value) {
    ensureDirectory(path.dirname(targetPath));
    fs.writeFileSync(targetPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function maskSecret(value) {
    const normalized = normalizeOptionalString(value);
    if (!normalized) {
        return '';
    }

    if (normalized.length <= 6) {
        return `${normalized.slice(0, 2)}...`;
    }

    return `${normalized.slice(0, 2)}...${normalized.slice(-2)}`;
}

function firstNonEmpty(...values) {
    for (const value of values) {
        const normalized = normalizeOptionalString(value);
        if (normalized) {
            return normalized;
        }
    }

    return '';
}

function nowIsoString() {
    return new Date().toISOString();
}

function buildActivity(phase = 'idle', label = '等待开始', percent = 0, detail = '') {
    return {
        phase,
        label,
        percent,
        detail,
        updatedAt: Date.now()
    };
}

function isValidRuntimeBase(rootPath) {
    if (!rootPath) {
        return false;
    }

    return [
        path.join(rootPath, 'openclaw.mjs'),
        path.join(rootPath, 'package.json'),
        path.join(rootPath, 'dist', 'entry.js'),
        path.join(rootPath, 'dist', 'plugin-sdk', 'gateway-runtime.js')
    ].every((candidate) => fileExists(candidate));
}

function hasRequiredRuntimePackages(rootPath) {
    if (!rootPath) {
        return false;
    }

    return REQUIRED_RUNTIME_PACKAGES.every((packageName) => (
        fileExists(path.join(rootPath, 'node_modules', packageName, 'package.json')) ||
        fileExists(path.join(rootPath, 'node_modules', packageName, 'index.js'))
    ));
}

function isValidRuntimeRoot(rootPath) {
    return (
        isValidRuntimeBase(rootPath) &&
        fileExists(path.join(rootPath, 'node_modules')) &&
        hasRequiredRuntimePackages(rootPath)
    );
}

function resolveExistingPath(candidates) {
    for (const candidate of candidates) {
        const normalized = normalizeOptionalString(candidate);
        if (normalized && fileExists(normalized)) {
            return normalized;
        }
    }

    return '';
}

function isLoopbackHost(hostname) {
    const normalized = normalizeOptionalString(hostname).toLowerCase();
    return (
        !normalized ||
        normalized === '127.0.0.1' ||
        normalized === 'localhost' ||
        normalized === '::1'
    );
}

function normalizeGatewayAddress(rawUrl) {
    const normalized = normalizeOptionalString(rawUrl, DEFAULT_GATEWAY_URL);
    let candidate = normalized;

    if (/^\d+$/.test(candidate)) {
        candidate = `ws://127.0.0.1:${candidate}`;
    } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
        candidate = `ws://${candidate}`;
    }

    try {
        const resolvedUrl = new URL(candidate);
        const host = normalizeOptionalString(resolvedUrl.hostname, '127.0.0.1');
        const port = Number.parseInt(resolvedUrl.port || '', 10) || DEFAULT_GATEWAY_PORT;
        const managed = isLoopbackHost(host);

        return {
            url: `ws://${managed ? '127.0.0.1' : host}:${port}`,
            displayUrl: `${resolvedUrl.protocol}//${host}:${port}`,
            host,
            probeHost: host === '::1' ? '::1' : '127.0.0.1',
            port,
            managed
        };
    } catch {
        return {
            url: DEFAULT_GATEWAY_URL,
            displayUrl: DEFAULT_GATEWAY_URL,
            host: '127.0.0.1',
            probeHost: '127.0.0.1',
            port: DEFAULT_GATEWAY_PORT,
            managed: true
        };
    }
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function canConnect(host, port, timeoutMs = 600) {
    return new Promise((resolve) => {
        const socket = net.connect({
            host,
            port,
            timeout: timeoutMs
        });

        let settled = false;
        const finish = (value) => {
            if (settled) {
                return;
            }

            settled = true;
            socket.destroy();
            resolve(value);
        };

        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
    });
}

function isChildAlive(child) {
    return Boolean(child && child.exitCode === null && !child.killed);
}

function resolveAppPath(app) {
    return app?.getAppPath?.() || process.cwd();
}

function resolveResourceRoot(app) {
    const appPath = resolveAppPath(app);

    if (app?.isPackaged && typeof process.resourcesPath === 'string' && process.resourcesPath) {
        return process.resourcesPath;
    }

    return appPath.endsWith('.asar') ? path.dirname(appPath) : appPath;
}

function resolveBundledOpenClawRoot(app) {
    const appPath = resolveAppPath(app);
    const resourceRoot = resolveResourceRoot(app);

    const candidates = [
        path.join(resourceRoot, 'openclaw-runtime'),
        path.join(appPath, 'build-cache', 'openclaw-runtime'),
        path.resolve(appPath, '..', 'build-cache', 'openclaw-runtime')
    ];

    for (const candidate of candidates) {
        if (isValidRuntimeBase(candidate)) {
            return candidate;
        }
    }

    return '';
}

function resolveBundledRuntimeNodeModules(app) {
    const appPath = resolveAppPath(app);
    const resourceRoot = resolveResourceRoot(app);

    return resolveExistingPath([
        path.join(resourceRoot, 'openclaw-runtime-node-modules'),
        path.join(resourceRoot, 'openclaw-runtime', 'node_modules'),
        path.join(appPath, 'build-cache', 'openclaw-runtime', 'node_modules'),
        path.resolve(appPath, '..', 'build-cache', 'openclaw-runtime', 'node_modules')
    ]);
}

function resolveBundledNodePath(app) {
    const appPath = resolveAppPath(app);
    const resourceRoot = resolveResourceRoot(app);
    const nodeBinaryName = process.platform === 'win32' ? 'node.exe' : 'node';

    return resolveExistingPath([
        path.join(resourceRoot, 'openclaw-vendor', nodeBinaryName),
        path.join(appPath, 'build-cache', 'openclaw-vendor', nodeBinaryName),
        path.resolve(appPath, '..', 'build-cache', 'openclaw-vendor', nodeBinaryName)
    ]);
}

class OpenClawRuntimeSupervisor extends EventEmitter {
    constructor(options = {}) {
        super();

        this.app = options.app;
        this.userDataDir = options.userDataDir;
        this.logsDir = options.logsDir;
        this.gatewayUrl = normalizeOptionalString(options.gatewayUrl, DEFAULT_GATEWAY_URL);
        this.address = normalizeGatewayAddress(this.gatewayUrl);
        this.resourceRoot = resolveResourceRoot(this.app);
        this.bundledRuntimeRoot = resolveBundledOpenClawRoot(this.app);
        this.bundledRuntimeNodeModulesPath = resolveBundledRuntimeNodeModules(this.app);
        this.materializedRuntimeRoot = path.join(this.userDataDir, 'runtime-bundle');
        this.bundleRoot = this.bundledRuntimeRoot;
        this.vendorNodePath = resolveBundledNodePath(this.app);
        this.openClawHome = path.join(this.userDataDir, 'openclaw-home');
        this.openClawConfigDir = path.join(this.openClawHome, '.openclaw');
        this.stdoutLogPath = path.join(this.logsDir, 'gateway.out.log');
        this.stderrLogPath = path.join(this.logsDir, 'gateway.err.log');
        this.bootstrapStdoutLogPath = path.join(this.logsDir, 'bootstrap.out.log');
        this.bootstrapStderrLogPath = path.join(this.logsDir, 'bootstrap.err.log');
        this.child = null;
        this.childStdoutStream = null;
        this.childStderrStream = null;
        this.recentOutput = {
            stdout: '',
            stderr: ''
        };
        this.health = 'idle';
        this.lastError = '';
        this.lastStartedAt = 0;
        this.lastRepairAt = 0;
        this.startPromise = null;
        this.configurePromise = null;
        this.closedManually = false;
        this.activity = buildActivity();
        this.providerCatalog = this.getPublicProviderCatalog();
        this.providerSetup = this.inspectProviderSetup();
    }

    getPublicProviderCatalog() {
        return PROVIDER_PRESETS.map((preset) => ({
            id: preset.id,
            label: preset.label,
            description: preset.description,
            alias: preset.alias,
            envVar: preset.envVar || '',
            custom: Boolean(preset.custom),
            defaultModel: preset.defaultModel || '',
            defaultProviderId: preset.defaultProviderId || '',
            defaultModelName: preset.defaultModelName || '',
            modelPlaceholder: preset.modelPlaceholder || '',
            baseUrlPlaceholder: preset.baseUrlPlaceholder || '',
            providerIdPlaceholder: preset.providerIdPlaceholder || '',
            modelSuggestions: Array.isArray(preset.modelSuggestions) ? [...preset.modelSuggestions] : []
        }));
    }

    getConfigPath() {
        return path.join(this.openClawConfigDir, 'openclaw.json');
    }

    getAgentDir() {
        return path.join(this.openClawConfigDir, 'agents', 'main', 'agent');
    }

    getAuthStorePath() {
        return path.join(this.getAgentDir(), 'auth-profiles.json');
    }

    getModelsPath() {
        return path.join(this.getAgentDir(), 'models.json');
    }

    getWorkspacePath() {
        return path.join(this.openClawConfigDir, 'workspace');
    }

    getSdkPath() {
        return this.bundleRoot
            ? path.join(this.bundleRoot, 'dist', 'plugin-sdk', 'gateway-runtime.js')
            : '';
    }

    isBundleReady() {
        return isValidRuntimeRoot(this.bundleRoot);
    }

    isVendorReady() {
        return Boolean(this.vendorNodePath && fileExists(this.vendorNodePath));
    }

    setActivity(phase, label, percent, detail = '') {
        this.activity = buildActivity(phase, label, percent, detail);
        this.emitStatus();
    }

    setLastError(message) {
        this.lastError = normalizeOptionalString(message);
        this.emitStatus();
    }

    refreshProviderSetup() {
        this.providerSetup = this.inspectProviderSetup();
        return this.providerSetup;
    }

    emitStatus() {
        this.emit('status', this.getStatus());
    }

    getStatus() {
        return {
            bundleReady: this.isBundleReady(),
            vendorReady: this.isVendorReady(),
            bundleRoot: this.bundleRoot,
            bundledRuntimeRoot: this.bundledRuntimeRoot,
            bundledRuntimeNodeModulesPath: this.bundledRuntimeNodeModulesPath,
            materializedRuntimeRoot: this.materializedRuntimeRoot,
            vendorNodePath: this.vendorNodePath,
            gatewayUrl: this.address.displayUrl,
            gatewayPort: this.address.port,
            openClawHome: this.openClawHome,
            openClawConfigDir: this.openClawConfigDir,
            configPath: this.getConfigPath(),
            agentDir: this.getAgentDir(),
            modelsPath: this.getModelsPath(),
            logsDir: this.logsDir,
            stdoutLogPath: this.stdoutLogPath,
            stderrLogPath: this.stderrLogPath,
            bootstrapStdoutLogPath: this.bootstrapStdoutLogPath,
            bootstrapStderrLogPath: this.bootstrapStderrLogPath,
            running: isChildAlive(this.child),
            pid: isChildAlive(this.child) ? this.child.pid : 0,
            health: this.health,
            lastError: this.lastError,
            lastStartedAt: this.lastStartedAt,
            lastRepairAt: this.lastRepairAt,
            activity: this.activity,
            providerCatalog: this.providerCatalog,
            providerSetup: this.providerSetup
        };
    }

    ensureLayout() {
        ensureDirectory(this.userDataDir);
        ensureDirectory(this.logsDir);
        ensureDirectory(this.openClawHome);
        ensureDirectory(this.openClawConfigDir);
        ensureDirectory(this.getAgentDir());
        ensureDirectory(this.getWorkspacePath());
    }

    materializeBundledRuntime() {
        const stagingRoot = `${this.materializedRuntimeRoot}.next`;

        this.setActivity('prepare-runtime', '准备本地 Runtime', 12, '首次启动会把依赖树还原到用户目录。');
        fs.rmSync(stagingRoot, { recursive: true, force: true });
        fs.rmSync(this.materializedRuntimeRoot, { recursive: true, force: true });
        fs.cpSync(this.bundledRuntimeRoot, stagingRoot, {
            recursive: true,
            force: true,
            dereference: true
        });
        this.setActivity('prepare-runtime', '恢复 Node 依赖', 22, '正在写入 OpenClaw 运行时依赖。');
        fs.cpSync(
            this.bundledRuntimeNodeModulesPath,
            path.join(stagingRoot, 'node_modules'),
            {
                recursive: true,
                force: true,
                dereference: true
            }
        );

        if (!isValidRuntimeRoot(stagingRoot)) {
            fs.rmSync(stagingRoot, { recursive: true, force: true });
            throw new Error('OpenClaw runtime 首启解包后校验失败。');
        }

        fs.renameSync(stagingRoot, this.materializedRuntimeRoot);

        if (!isValidRuntimeRoot(this.materializedRuntimeRoot)) {
            throw new Error('OpenClaw runtime 落盘后校验失败。');
        }
    }

    prepareBundledRuntime(force = false) {
        if (!force && isValidRuntimeRoot(this.bundledRuntimeRoot)) {
            this.bundleRoot = this.bundledRuntimeRoot;
            return this.bundleRoot;
        }

        if (!force && isValidRuntimeRoot(this.materializedRuntimeRoot)) {
            this.bundleRoot = this.materializedRuntimeRoot;
            return this.bundleRoot;
        }

        if (!isValidRuntimeBase(this.bundledRuntimeRoot)) {
            this.bundleRoot = '';
            return this.bundleRoot;
        }

        if (!this.bundledRuntimeNodeModulesPath || !fileExists(this.bundledRuntimeNodeModulesPath)) {
            this.bundleRoot = this.bundledRuntimeRoot;
            return this.bundleRoot;
        }

        this.materializeBundledRuntime();
        this.bundleRoot = this.materializedRuntimeRoot;
        return this.bundleRoot;
    }

    applyEnvironment() {
        if (!this.bundleRoot) {
            return;
        }

        const sdkPath = this.getSdkPath();
        process.env.OPENCLAW_HOME = this.openClawHome;
        process.env.OPENCLAW_REPO = this.bundleRoot;
        process.env.OPENCLAW_SDK_PATH = sdkPath;
        process.env.OPENCLAW_GATEWAY_URL = this.address.url;
    }

    appendRecentOutput(kind, chunk) {
        const text = chunk ? String(chunk) : '';
        if (!text) {
            return;
        }

        this.recentOutput[kind] = `${this.recentOutput[kind]}${text}`.slice(-24000);
    }

    appendBootstrapLog(kind, text) {
        const normalized = normalizeOptionalString(text);
        if (!normalized) {
            return;
        }

        const targetPath = kind === 'stderr'
            ? this.bootstrapStderrLogPath
            : this.bootstrapStdoutLogPath;
        fs.appendFileSync(targetPath, `${normalized}\n`, 'utf8');
    }

    readFailureContext() {
        const stderr = normalizeOptionalString(this.recentOutput.stderr);
        const stdout = normalizeOptionalString(this.recentOutput.stdout);
        const blocks = [];

        if (stderr) {
            blocks.push(`stderr:\n${stderr.split(/\r?\n/).slice(-20).join('\n')}`);
        }
        if (stdout) {
            blocks.push(`stdout:\n${stdout.split(/\r?\n/).slice(-20).join('\n')}`);
        }

        return blocks.length > 0 ? `\n\n${blocks.join('\n\n')}` : '';
    }

    buildSpawnEnvironment() {
        const env = {
            ...process.env,
            OPENCLAW_HOME: this.openClawHome,
            OPENCLAW_REPO: this.bundleRoot,
            OPENCLAW_SDK_PATH: this.getSdkPath(),
            OPENCLAW_GATEWAY_URL: this.address.url
        };

        if (!this.isVendorReady()) {
            env.ELECTRON_RUN_AS_NODE = '1';
        }

        return env;
    }

    runCliCommand(subArgs, { timeoutMs = DEFAULT_BOOTSTRAP_TIMEOUT_MS, strict = true, omitGatewayEnv = false } = {}) {
        this.ensureLayout();
        const nodeBinary = this.isVendorReady() ? this.vendorNodePath : process.execPath;
        const env = {
            ...this.buildSpawnEnvironment()
        };

        if (omitGatewayEnv) {
            delete env.OPENCLAW_GATEWAY_URL;
        }

        const args = [path.join(this.bundleRoot, 'openclaw.mjs'), ...subArgs];
        const result = spawnSync(nodeBinary, args, {
            cwd: this.bundleRoot,
            env,
            encoding: 'utf8',
            windowsHide: true,
            timeout: timeoutMs,
            maxBuffer: 12 * 1024 * 1024
        });

        this.appendRecentOutput('stdout', result.stdout || '');
        this.appendRecentOutput('stderr', result.stderr || '');
        this.appendBootstrapLog('stdout', result.stdout || '');
        this.appendBootstrapLog('stderr', result.stderr || '');

        if (result.error) {
            if (strict) {
                throw result.error;
            }
            this.lastError = result.error.message || String(result.error);
            return result;
        }

        if (result.status !== 0 && strict) {
            throw new Error(
                `OpenClaw 命令执行失败（exit=${result.status || 1}）${this.readFailureContext()}`
            );
        }

        return result;
    }

    runDoctorRepair({ force = false, strict = false } = {}) {
        if (!this.isBundleReady()) {
            return false;
        }

        const args = [
            'doctor',
            '--fix',
            '--non-interactive',
            '--yes'
        ];

        if (force) {
            args.push('--force');
        }

        const result = this.runCliCommand(args, {
            strict,
            omitGatewayEnv: true
        });

        return result.status === 0;
    }

    buildLaunchArgs(reset = false) {
        const args = [
            path.join(this.bundleRoot, 'openclaw.mjs'),
            'gateway',
            '--dev',
            '--force',
            '--allow-unconfigured',
            '--bind',
            'loopback',
            '--auth',
            'none',
            '--port',
            String(this.address.port),
            '--verbose'
        ];

        if (reset) {
            args.push('--reset');
        }

        args.push('run');
        return args;
    }

    spawnGatewayProcess(reset = false) {
        this.ensureLayout();
        this.recentOutput.stdout = '';
        this.recentOutput.stderr = '';
        this.closedManually = false;

        const nodeBinary = this.isVendorReady() ? this.vendorNodePath : process.execPath;
        const child = spawn(nodeBinary, this.buildLaunchArgs(reset), {
            cwd: this.bundleRoot,
            env: this.buildSpawnEnvironment(),
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });

        this.child = child;
        this.childStdoutStream = fs.createWriteStream(this.stdoutLogPath, { flags: 'a' });
        this.childStderrStream = fs.createWriteStream(this.stderrLogPath, { flags: 'a' });
        this.lastStartedAt = Date.now();
        if (reset) {
            this.lastRepairAt = this.lastStartedAt;
        }

        child.stdout.on('data', (chunk) => {
            this.appendRecentOutput('stdout', chunk);
            this.childStdoutStream?.write(chunk);
        });
        child.stderr.on('data', (chunk) => {
            this.appendRecentOutput('stderr', chunk);
            this.childStderrStream?.write(chunk);
        });

        child.on('error', (error) => {
            this.lastError = error instanceof Error ? error.message : String(error);
            this.health = 'error';
            this.setActivity('error', 'Gateway 启动失败', 0, this.lastError);
        });

        child.on('close', (code, signal) => {
            this.childStdoutStream?.end();
            this.childStderrStream?.end();
            this.childStdoutStream = null;
            this.childStderrStream = null;

            if (this.child === child) {
                this.child = null;
            }

            if (!this.closedManually) {
                this.lastError = this.lastError || `OpenClaw Gateway 已退出 (${code ?? signal ?? 'unknown'})`;
                this.health = 'stopped';
                this.setActivity('stopped', 'Gateway 已停止', 0, this.lastError);
            }
        });
    }

    async waitForTcpPort(timeoutMs = 30000) {
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            if (await canConnect(this.address.probeHost, this.address.port, 800)) {
                return true;
            }
            if (this.child && this.child.exitCode !== null) {
                return false;
            }
            await delay(350);
        }

        return false;
    }

    async waitForGatewayProcessReady(timeoutMs = 30000) {
        const portReady = await this.waitForTcpPort(timeoutMs);
        if (portReady) {
            return;
        }

        if (this.child && this.child.exitCode !== null) {
            throw new Error(
                `OpenClaw Gateway 进程启动后提前退出 (${this.child.exitCode ?? 'unknown'})${this.readFailureContext()}`
            );
        }

        throw new Error(`等待 OpenClaw Gateway 监听 ${this.address.port} 超时${this.readFailureContext()}`);
    }

    async probeGatewayProtocol() {
        if (!this.isBundleReady()) {
            return false;
        }

        try {
            const deadline = Date.now() + 30000;

            while (Date.now() < deadline) {
                const tcpReady = await this.waitForTcpPort(1500);
                if (!tcpReady) {
                    await delay(500);
                    continue;
                }

                const probeClient = new OpenClawGatewayManager({
                    clientVersion: 'openclaw-runtime-probe',
                    enabled: true,
                    gatewayUrl: this.address.url
                });

                try {
                    await probeClient.ensureConnected();
                    await probeClient.request('sessions.list', { limit: 1 }, 8000);
                    return true;
                } catch (error) {
                    this.lastError = error instanceof Error ? error.message : String(error);
                    await probeClient.shutdown().catch(() => {});
                    await delay(750);
                }
            }

            return false;
        } catch (error) {
            this.lastError = error instanceof Error ? error.message : String(error);
            return false;
        }
    }

    async stopChild() {
        if (!isChildAlive(this.child)) {
            this.child = null;
            return;
        }

        const child = this.child;
        this.closedManually = true;

        try {
            child.kill();
        } catch {}

        const deadline = Date.now() + 6000;
        while (Date.now() < deadline) {
            if (child.exitCode !== null) {
                break;
            }
            await delay(200);
        }

        if (child.exitCode === null && process.platform === 'win32' && child.pid) {
            spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
                stdio: 'ignore',
                shell: true
            });
        }

        this.child = null;
    }

    async spawnAndVerify(reset = false) {
        await this.stopChild();
        this.health = reset ? 'repairing' : 'bootstrapping';
        this.lastError = '';
        this.setActivity(
            reset ? 'repair-runtime' : 'start-gateway',
            reset ? '执行深度修复' : '启动 Gateway',
            reset ? 58 : 52,
            reset ? '正在用更激进的修复策略重启 Runtime。' : '正在拉起本机 WebSocket Gateway。'
        );
        this.spawnGatewayProcess(reset);
        this.setActivity('start-gateway', '等待端口监听', 70, `等待 ${this.address.displayUrl} 就绪。`);
        await this.waitForGatewayProcessReady(reset ? 140000 : 100000);

        this.setActivity('probe-gateway', '验证 Gateway 握手', 86, '正在确认 RPC 和事件流可用。');
        const protocolReady = await this.probeGatewayProtocol();
        if (!protocolReady) {
            throw new Error(
                `${reset ? 'OpenClaw Gateway 自修复后仍未通过握手检查' : 'OpenClaw Gateway 握手检查失败'}${this.readFailureContext()}`
            );
        }

        this.health = 'running';
        this.lastError = '';
        this.refreshProviderSetup();
        this.setActivity('running', 'Runtime 已就绪', 100, '现在可以接入 HumanClaw 或其他前端。');
    }

    createBaseConfig() {
        return {
            env: {
                vars: {}
            },
            agents: {
                defaults: {
                    workspace: this.getWorkspacePath(),
                    model: {}
                }
            },
            gateway: {
                mode: 'local',
                port: this.address.port,
                bind: 'loopback',
                tailscale: {
                    mode: 'off',
                    resetOnExit: false
                }
            },
            session: {
                dmScope: 'per-channel-peer'
            },
            tools: {
                profile: 'coding'
            },
            wizard: {},
            meta: {}
        };
    }

    ensureBaseConfig() {
        const configPath = this.getConfigPath();
        const existing = readJsonIfExists(configPath);
        const config = ensureObject(existing);
        const base = this.createBaseConfig();

        config.env = ensureObject(config.env);
        config.env.vars = ensureObject(config.env.vars);

        config.agents = ensureObject(config.agents);
        config.agents.defaults = ensureObject(config.agents.defaults);
        config.agents.defaults.workspace = firstNonEmpty(
            config.agents.defaults.workspace,
            base.agents.defaults.workspace
        );
        config.agents.defaults.model = ensureObject(config.agents.defaults.model);

        config.gateway = ensureObject(config.gateway);
        config.gateway.mode = firstNonEmpty(config.gateway.mode, 'local');
        config.gateway.port = Number.isFinite(config.gateway.port) ? config.gateway.port : this.address.port;
        config.gateway.bind = firstNonEmpty(config.gateway.bind, 'loopback');
        config.gateway.tailscale = ensureObject(config.gateway.tailscale);
        if (!normalizeOptionalString(config.gateway.tailscale.mode)) {
            config.gateway.tailscale.mode = 'off';
        }
        if (typeof config.gateway.tailscale.resetOnExit !== 'boolean') {
            config.gateway.tailscale.resetOnExit = false;
        }

        config.session = ensureObject(config.session);
        config.session.dmScope = firstNonEmpty(config.session.dmScope, 'per-channel-peer');

        config.tools = ensureObject(config.tools);
        config.tools.profile = firstNonEmpty(config.tools.profile, 'coding');

        config.wizard = ensureObject(config.wizard);
        config.meta = ensureObject(config.meta);

        return config;
    }

    inspectProviderSetup() {
        const configPath = this.getConfigPath();
        const modelsPath = this.getModelsPath();
        const config = readJsonIfExists(configPath);
        const defaultModel = normalizeOptionalString(config?.agents?.defaults?.model?.primary);
        const providerId = defaultModel.includes('/')
            ? defaultModel.split('/')[0]
            : '';
        const modelName = defaultModel.includes('/')
            ? defaultModel.slice(defaultModel.indexOf('/') + 1)
            : '';
        const preset = PROVIDER_PRESET_MAP.get(providerId);
        const envVars = ensureObject(config?.env?.vars);
        const customProviders = ensureObject(config?.models?.providers);
        const customProvider = providerId ? ensureObject(customProviders[providerId]) : {};
        const customApiKey = normalizeOptionalString(customProvider?.apiKey);
        const baseUrl = normalizeOptionalString(customProvider?.baseUrl);
        const isCustomProvider = Boolean(!preset && providerId && Object.keys(customProvider).length > 0);
        const builtInEnvVar = preset?.envVar || '';
        const builtInKey = builtInEnvVar ? normalizeOptionalString(envVars[builtInEnvVar]) : '';
        const configured = isCustomProvider
            ? Boolean(providerId && baseUrl && customApiKey && modelName)
            : preset?.custom
                ? Boolean(providerId && baseUrl && customApiKey && modelName)
            : Boolean(providerId && builtInKey && defaultModel);

        const authSources = [];
        for (const catalogEntry of PROVIDER_PRESETS) {
            if (catalogEntry.envVar && normalizeOptionalString(envVars[catalogEntry.envVar])) {
                authSources.push({
                    providerId: catalogEntry.id,
                    providerLabel: catalogEntry.label,
                    source: `env.vars.${catalogEntry.envVar}`,
                    maskedValue: maskSecret(envVars[catalogEntry.envVar])
                });
            }
        }

        if (providerId && !preset && customApiKey) {
            authSources.push({
                providerId,
                providerLabel: providerId,
                source: `models.providers.${providerId}.apiKey`,
                maskedValue: maskSecret(customApiKey)
            });
        }

        return {
            configured,
            configPath,
            modelsPath,
            providerId,
            providerLabel: preset?.label || providerId || '未配置',
            providerKind: isCustomProvider ? 'custom' : preset?.custom ? 'custom' : preset ? 'builtin' : providerId ? 'custom' : 'none',
            defaultModel,
            modelName,
            envVar: builtInEnvVar,
            maskedKey: maskSecret(builtInKey || customApiKey),
            baseUrl,
            authSources,
            lastConfiguredAt: firstNonEmpty(config?.wizard?.lastRunAt, config?.meta?.lastTouchedAt),
            workspacePath: firstNonEmpty(config?.agents?.defaults?.workspace, this.getWorkspacePath()),
            configExists: Boolean(config)
        };
    }

    resolveConfiguredSecret(config, providerId, options) {
        const preset = PROVIDER_PRESET_MAP.get(providerId);
        if (!preset) {
            return '';
        }

        if (preset.custom) {
            const customProviderId = normalizeOptionalString(options.customProviderId, preset.defaultProviderId);
            return normalizeOptionalString(config?.models?.providers?.[customProviderId]?.apiKey);
        }

        return normalizeOptionalString(config?.env?.vars?.[preset.envVar]);
    }

    normalizeProviderInput(input = {}) {
        const providerId = normalizeOptionalString(input.providerId);
        const preset = PROVIDER_PRESET_MAP.get(providerId);
        if (!preset) {
            throw new Error('不支持的 Provider。');
        }

        const model = normalizeOptionalString(input.model);
        const apiKey = normalizeOptionalString(input.apiKey);
        const secretMode = normalizeOptionalString(input.secretMode, 'plaintext');

        if (preset.custom) {
            const customProviderId = normalizeOptionalString(input.customProviderId, preset.defaultProviderId);
            const customModelName = normalizeOptionalString(input.customModelName, preset.defaultModelName);
            const baseUrl = normalizeOptionalString(input.baseUrl);

            if (!customProviderId) {
                throw new Error('请填写自定义 Provider ID。');
            }
            if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(customProviderId)) {
                throw new Error('自定义 Provider ID 只支持字母、数字、下划线和中划线。');
            }
            if (!customModelName) {
                throw new Error('请填写模型 ID。');
            }
            if (!baseUrl) {
                throw new Error('请填写兼容 /v1 的 Base URL。');
            }
            try {
                const resolved = new URL(baseUrl);
                if (!/^https?:$/i.test(resolved.protocol)) {
                    throw new Error('bad protocol');
                }
            } catch {
                throw new Error('Base URL 格式不正确。');
            }

            return {
                providerId,
                preset,
                apiKey,
                secretMode,
                customProviderId,
                customModelName,
                baseUrl: baseUrl.replace(/\/+$/, ''),
                defaultModel: `${customProviderId}/${customModelName}`
            };
        }

        const resolvedModel = normalizeOptionalString(model, preset.defaultModel);
        if (!resolvedModel) {
            throw new Error('请填写默认模型。');
        }

        return {
            providerId,
            preset,
            apiKey,
            secretMode,
            defaultModel: resolvedModel
        };
    }

    writeProviderConfig(config, normalized) {
        const timestamp = nowIsoString();
        const configPath = this.getConfigPath();
        const preset = normalized.preset;

        config.agents = ensureObject(config.agents);
        config.agents.defaults = ensureObject(config.agents.defaults);
        config.agents.defaults.workspace = firstNonEmpty(
            config.agents.defaults.workspace,
            this.getWorkspacePath()
        );
        config.agents.defaults.model = ensureObject(config.agents.defaults.model);
        config.agents.defaults.model.primary = normalized.defaultModel;
        config.agents.defaults.models = ensureObject(config.agents.defaults.models);
        config.agents.defaults.models[normalized.defaultModel] = {
            ...ensureObject(config.agents.defaults.models[normalized.defaultModel]),
            alias: preset.alias || normalized.customProviderId || normalized.providerId
        };

        config.gateway = ensureObject(config.gateway);
        config.gateway.mode = 'local';
        config.gateway.port = this.address.port;
        config.gateway.bind = 'loopback';
        config.gateway.tailscale = ensureObject(config.gateway.tailscale);
        config.gateway.tailscale.mode = firstNonEmpty(config.gateway.tailscale.mode, 'off');
        if (typeof config.gateway.tailscale.resetOnExit !== 'boolean') {
            config.gateway.tailscale.resetOnExit = false;
        }

        config.session = ensureObject(config.session);
        config.session.dmScope = firstNonEmpty(config.session.dmScope, 'per-channel-peer');

        config.tools = ensureObject(config.tools);
        config.tools.profile = firstNonEmpty(config.tools.profile, 'coding');

        config.env = ensureObject(config.env);
        config.env.vars = ensureObject(config.env.vars);
        config.models = ensureObject(config.models);
        config.models.providers = ensureObject(config.models.providers);

        if (preset.custom) {
            const providerId = normalized.customProviderId;
            const existingProvider = ensureObject(config.models.providers[providerId]);
            const existingModelEntries = Array.isArray(existingProvider.models)
                ? existingProvider.models
                : [];
            const existingPrimaryModel = existingModelEntries.find((entry) => (
                normalizeOptionalString(entry?.id) === normalized.customModelName
            ));

            config.models.mode = firstNonEmpty(config.models.mode, 'merge');
            config.models.providers[providerId] = {
                ...existingProvider,
                baseUrl: normalized.baseUrl,
                apiKey: normalized.apiKey || normalizeOptionalString(existingProvider.apiKey),
                api: firstNonEmpty(existingProvider.api, 'openai-responses'),
                models: [
                    {
                        id: normalized.customModelName,
                        name: firstNonEmpty(existingPrimaryModel?.name, normalized.customModelName),
                        reasoning: typeof existingPrimaryModel?.reasoning === 'boolean'
                            ? existingPrimaryModel.reasoning
                            : false,
                        input: Array.isArray(existingPrimaryModel?.input) && existingPrimaryModel.input.length > 0
                            ? existingPrimaryModel.input
                            : ['text'],
                        cost: ensureObject(existingPrimaryModel?.cost).input !== undefined
                            ? existingPrimaryModel.cost
                            : {
                                input: 0,
                                output: 0,
                                cacheRead: 0,
                                cacheWrite: 0
                            },
                        contextWindow: Number.isFinite(existingPrimaryModel?.contextWindow)
                            ? existingPrimaryModel.contextWindow
                            : DEFAULT_MODEL_CONTEXT_WINDOW,
                        maxTokens: Number.isFinite(existingPrimaryModel?.maxTokens)
                            ? existingPrimaryModel.maxTokens
                            : DEFAULT_MODEL_MAX_TOKENS
                    }
                ]
            };
        } else if (preset.envVar) {
            const nextValue = normalized.apiKey || normalizeOptionalString(config.env.vars[preset.envVar]);
            if (!nextValue) {
                throw new Error(`${preset.label} 的 API Key 不能为空。`);
            }
            config.env.vars[preset.envVar] = nextValue;
        }

        config.wizard = ensureObject(config.wizard);
        config.wizard.lastRunAt = timestamp;
        config.wizard.lastRunVersion = 'openclaw-runtime-installer';
        config.wizard.lastRunCommand = 'runtime-installer-provider-setup';
        config.wizard.lastRunMode = 'local';

        config.meta = ensureObject(config.meta);
        config.meta.lastTouchedVersion = 'openclaw-runtime-installer';
        config.meta.lastTouchedAt = timestamp;

        writeJsonFile(configPath, config);
        return config;
    }

    async configureProvider(input = {}) {
        if (this.configurePromise) {
            await this.configurePromise;
            return this.getStatus();
        }

        this.configurePromise = (async () => {
            if (this.startPromise) {
                try {
                    await this.startPromise;
                } catch {}
            }

            this.ensureLayout();
            this.prepareBundledRuntime();
            this.applyEnvironment();

            const config = this.ensureBaseConfig();
            const normalized = this.normalizeProviderInput(input);
            const existingSecret = this.resolveConfiguredSecret(config, normalized.providerId, normalized);

            if (!normalized.apiKey && !existingSecret) {
                throw new Error('请填写 API Key，或者保留一个已存在的 Key。');
            }

            if (!normalized.apiKey && existingSecret) {
                normalized.apiKey = existingSecret;
            }

            this.health = 'configuring';
            this.lastError = '';
            this.setActivity('provider-config', '写入 Provider 配置', 18, '正在保存模型和认证信息。');

            this.writeProviderConfig(config, normalized);
            this.refreshProviderSetup();

            this.setActivity('provider-config', '校验配置结构', 36, '正在执行 openclaw config validate。');
            this.runCliCommand(['config', 'validate'], {
                strict: true,
                omitGatewayEnv: true
            });
            this.refreshProviderSetup();
            this.setActivity('provider-config', '应用默认模型', 52, normalized.defaultModel);
            this.setActivity('provider-config', '重启 Runtime 应用新配置', 72, '正在重启 Gateway。');
            await this.stopChild();
            this.health = 'stopped';
            this.emitStatus();
            await this.ensureReady();

            this.refreshProviderSetup();
            this.health = 'running';
            this.lastError = '';
            this.setActivity(
                'provider-ready',
                'Provider 已配置',
                100,
                `${this.providerSetup.providerLabel} / ${this.providerSetup.defaultModel || normalized.defaultModel}`
            );
        })().catch((error) => {
            this.health = 'error';
            this.lastError = error instanceof Error ? error.message : String(error);
            this.setActivity('error', 'Provider 配置失败', 0, this.lastError);
            throw error;
        }).finally(() => {
            this.configurePromise = null;
        });

        await this.configurePromise;
        return this.getStatus();
    }

    async ensureReady() {
        if (!this.address.managed) {
            this.health = 'error';
            this.lastError = '当前安装器只接管 127.0.0.1 / localhost 本机 Gateway。';
            this.setActivity('error', '地址不受支持', 0, this.lastError);
            throw new Error(this.lastError);
        }

        this.ensureLayout();

        try {
            this.prepareBundledRuntime();
        } catch (error) {
            this.health = 'error';
            this.lastError = error instanceof Error ? error.message : String(error);
            this.setActivity('error', 'Runtime 准备失败', 0, this.lastError);
            throw error;
        }

        if (!this.isBundleReady()) {
            this.health = 'error';
            this.lastError = '安装包里未找到 OpenClaw runtime。';
            this.setActivity('error', 'Runtime 缺失', 0, this.lastError);
            throw new Error(this.lastError);
        }

        if (this.startPromise) {
            await this.startPromise;
            return this.getStatus();
        }

        this.startPromise = (async () => {
            this.applyEnvironment();
            this.setActivity('doctor', '执行 Runtime 体检', 34, '正在自动修复基础配置。');

            try {
                this.runDoctorRepair({ force: false, strict: false });
            } catch (error) {
                this.lastError = error instanceof Error ? error.message : String(error);
                this.health = 'repairing';
                this.setActivity('repair-runtime', 'Runtime 体检遇到问题', 44, this.lastError);
            }

            this.setActivity('probe-gateway', '检查现有 Gateway', 46, '如果已经在跑，就直接复用。');
            const alreadyHealthy = await this.probeGatewayProtocol();
            if (alreadyHealthy) {
                this.health = 'running';
                this.lastError = '';
                this.refreshProviderSetup();
                this.setActivity('running', 'Runtime 已就绪', 100, '本机 Gateway 已可连接。');
                return;
            }

            try {
                await this.spawnAndVerify(false);
            } catch (error) {
                this.lastError = error instanceof Error ? error.message : String(error);
                this.health = 'repairing';
                this.setActivity('repair-runtime', '执行深度修复', 58, this.lastError);
                this.prepareBundledRuntime(true);
                this.runDoctorRepair({ force: true, strict: false });
                await this.spawnAndVerify(true);
            }
        })().finally(() => {
            this.startPromise = null;
        });

        await this.startPromise;
        return this.getStatus();
    }

    async shutdown() {
        await this.stopChild();
        this.health = 'stopped';
        this.refreshProviderSetup();
        this.setActivity('stopped', 'Gateway 已停止', 0, 'Runtime 已停止，配置不会丢。');
        return this.getStatus();
    }
}

module.exports = {
    DEFAULT_GATEWAY_URL,
    OpenClawRuntimeSupervisor,
    PROVIDER_PRESETS
};
