const { EventEmitter } = require('events');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { OpenClawGatewayManager } = require('./openclaw-gateway.cjs');
const { applyOpenClawProviderSettings } = require('./openclaw-provider-config.cjs');
const {
    resolveHumanClawFsLayout,
    resolveOpenClawRepoHints
} = require('./fs-layout.cjs');

const DEFAULT_GATEWAY_URL = 'ws://127.0.0.1:19011';
const DEFAULT_GATEWAY_PORT = 19011;
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 180000;

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

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ensureDirectory(targetPath) {
    fs.mkdirSync(targetPath, { recursive: true });
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

function isValidRuntimeRoot(rootPath) {
    if (!rootPath) {
        return false;
    }

    return [
        path.join(rootPath, 'openclaw.mjs'),
        path.join(rootPath, 'package.json'),
        path.join(rootPath, 'dist', 'entry.js'),
        path.join(rootPath, 'dist', 'plugin-sdk', 'gateway-runtime.js'),
        path.join(rootPath, 'node_modules')
    ].every((candidate) => fileExists(candidate));
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

function resolveBundledOpenClawRoot(app, layout = resolveHumanClawFsLayout()) {
    const appPath = app?.getAppPath?.() || process.cwd();
    const resourceRoot = app?.isPackaged ? process.resourcesPath : appPath;

    const candidates = [
        path.join(resourceRoot, 'openclaw-runtime'),
        path.join(appPath, 'build-cache', 'openclaw-runtime'),
        path.resolve(appPath, '..', 'build-cache', 'openclaw-runtime'),
        path.resolve(appPath, 'tmp', 'openclaw-deploy-test'),
        ...resolveOpenClawRepoHints({
            layout,
            appPath
        })
    ];

    for (const candidate of candidates) {
        if (isValidRuntimeRoot(candidate)) {
            return candidate;
        }
    }

    return '';
}

function resolveBundledNodePath(app) {
    const appPath = app?.getAppPath?.() || process.cwd();
    const resourceRoot = app?.isPackaged ? process.resourcesPath : appPath;
    const nodeBinaryName = process.platform === 'win32' ? 'node.exe' : 'node';

    return resolveExistingPath([
        path.join(resourceRoot, 'openclaw-vendor', nodeBinaryName),
        path.join(appPath, 'build-cache', 'openclaw-vendor', nodeBinaryName),
        path.resolve(appPath, '..', 'build-cache', 'openclaw-vendor', nodeBinaryName)
    ]);
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

class OpenClawOperatorSupervisor extends EventEmitter {
    constructor(options = {}) {
        super();

        this.app = options.app;
        this.installEdition = 'assistant';
        this.gatewayUrl = DEFAULT_GATEWAY_URL;
        this.address = normalizeGatewayAddress(DEFAULT_GATEWAY_URL);
        this.layout = resolveHumanClawFsLayout({
            installEdition: options.installEdition
        });
        this.bundleRoot = '';
        this.vendorNodePath = '';
        this.managedHomeRoot = this.layout.sharedOpenClawHomeDir;
        this.logsDir = this.layout.sharedOpenClawLogsDir;
        this.stdoutLogPath = path.join(this.logsDir, 'operator-gateway.out.log');
        this.stderrLogPath = path.join(this.logsDir, 'operator-gateway.err.log');
        this.bootstrapStdoutLogPath = path.join(this.logsDir, 'operator-bootstrap.out.log');
        this.bootstrapStderrLogPath = path.join(this.logsDir, 'operator-bootstrap.err.log');
        this.child = null;
        this.childStdoutStream = null;
        this.childStderrStream = null;
        this.recentOutput = {
            stdout: '',
            stderr: ''
        };
        this.pendingRestart = false;
        this.closedManually = false;
        this.health = 'idle';
        this.lastError = '';
        this.lastStartedAt = 0;
        this.lastRepairAt = 0;
        this.startPromise = null;
        this.preferences = {};

        this.configure(options);
    }

    configure(options = {}) {
        const previousSignature = this.getLaunchSignature();
        this.installEdition = normalizeOptionalString(options.installEdition, this.installEdition || 'assistant');
        this.gatewayUrl = normalizeOptionalString(options.gatewayUrl, this.gatewayUrl || DEFAULT_GATEWAY_URL);
        this.address = normalizeGatewayAddress(this.gatewayUrl);
        if (isPlainObject(options.preferences)) {
            this.preferences = {
                ...options.preferences,
                assistantProvider: isPlainObject(options.preferences.assistantProvider)
                    ? { ...options.preferences.assistantProvider }
                    : {}
            };
        }
        this.layout = resolveHumanClawFsLayout({
            installEdition: this.installEdition
        });
        this.managedHomeRoot = this.layout.sharedOpenClawHomeDir;
        this.logsDir = this.layout.sharedOpenClawLogsDir;
        this.stdoutLogPath = path.join(this.logsDir, 'operator-gateway.out.log');
        this.stderrLogPath = path.join(this.logsDir, 'operator-gateway.err.log');
        this.bootstrapStdoutLogPath = path.join(this.logsDir, 'operator-bootstrap.out.log');
        this.bootstrapStderrLogPath = path.join(this.logsDir, 'operator-bootstrap.err.log');
        this.bundleRoot = resolveBundledOpenClawRoot(this.app, this.layout);
        this.vendorNodePath = resolveBundledNodePath(this.app);

        if (previousSignature && previousSignature !== this.getLaunchSignature()) {
            this.pendingRestart = true;
        }

        if (this.isEnabled()) {
            this.applyEnvironment();
        }

        this.emitStatus();
        return this.getStatus();
    }

    isEnabled() {
        return this.installEdition === 'operator';
    }

    getLaunchSignature() {
        return [
            this.installEdition,
            this.address.host,
            this.address.port,
            this.bundleRoot,
            this.vendorNodePath
        ].join('|');
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

    emitStatus() {
        this.emit('status', this.getStatus());
    }

    getStatus() {
        return {
            enabled: this.isEnabled(),
            managedLocalGateway: this.address.managed,
            bundleReady: this.isBundleReady(),
            vendorReady: this.isVendorReady(),
            bundleRoot: this.bundleRoot,
            vendorNodePath: this.vendorNodePath,
            gatewayUrl: this.address.displayUrl,
            port: this.address.port,
            homeRoot: this.managedHomeRoot,
            configRoot: path.join(this.managedHomeRoot, '.openclaw'),
            stdoutLogPath: this.stdoutLogPath,
            stderrLogPath: this.stderrLogPath,
            bootstrapStdoutLogPath: this.bootstrapStdoutLogPath,
            bootstrapStderrLogPath: this.bootstrapStderrLogPath,
            running: isChildAlive(this.child),
            pid: isChildAlive(this.child) ? this.child.pid : 0,
            health: this.health,
            lastError: this.lastError,
            lastStartedAt: this.lastStartedAt,
            lastRepairAt: this.lastRepairAt
        };
    }

    applyEnvironment() {
        if (!this.bundleRoot) {
            return;
        }

        const sdkPath = this.getSdkPath();
        process.env.OPENCLAW_HOME = this.managedHomeRoot;
        process.env.AIGRIL_OPENCLAW_HOME = this.managedHomeRoot;
        process.env.HUMANCLAW_OPENCLAW_HOME = this.managedHomeRoot;
        process.env.OPENCLAW_REPO = this.bundleRoot;
        process.env.AIGRIL_OPENCLAW_REPO = this.bundleRoot;
        process.env.OPENCLAW_SDK_PATH = sdkPath;
        process.env.AIGRIL_OPENCLAW_SDK_PATH = sdkPath;
    }

    ensureHomeStructure() {
        ensureDirectory(this.managedHomeRoot);
        ensureDirectory(path.join(this.managedHomeRoot, '.openclaw'));
        ensureDirectory(this.logsDir);
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

    appendRecentOutput(kind, chunk) {
        const text = chunk ? String(chunk) : '';
        if (!text) {
            return;
        }
        this.recentOutput[kind] = `${this.recentOutput[kind]}${text}`.slice(-24000);
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

    runBootstrapCommand(args, { timeoutMs = DEFAULT_BOOTSTRAP_TIMEOUT_MS, strict = false } = {}) {
        this.ensureHomeStructure();
        const nodeBinary = this.isVendorReady() ? this.vendorNodePath : process.execPath;
        const env = {
            ...this.buildSpawnEnvironment()
        };
        delete env.OPENCLAW_GATEWAY_URL;
        delete env.AIGRIL_OPENCLAW_GATEWAY_URL;
        delete env.HUMANCLAW_OPENCLAW_GATEWAY_URL;

        const result = spawnSync(nodeBinary, args, {
            cwd: this.bundleRoot,
            env,
            encoding: 'utf8',
            windowsHide: true,
            timeout: timeoutMs,
            maxBuffer: 8 * 1024 * 1024
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
            return false;
        }

        if (result.status !== 0) {
            const message = `OpenClaw 自修复命令失败（exit=${result.status || 1}）${this.readFailureContext()}`;
            if (strict) {
                throw new Error(message);
            }
            this.lastError = message;
            return false;
        }

        return true;
    }

    seedManagedConfig() {
        if (!this.isBundleReady()) {
            return null;
        }

        this.ensureHomeStructure();
        return applyOpenClawProviderSettings({
            operatorSupervisor: this,
            appPath: this.app?.getAppPath?.() || process.cwd(),
            preferences: this.preferences || {},
            providerPatch: {
                ...(this.preferences?.assistantProvider || {})
            }
        });
    }

    runDoctorRepair({ force = false, strict = false } = {}) {
        if (!this.isBundleReady()) {
            return false;
        }

        const args = [
            path.join(this.bundleRoot, 'openclaw.mjs'),
            'doctor',
            '--fix',
            '--non-interactive',
            '--yes'
        ];

        if (force) {
            args.push('--force');
        }

        return this.runBootstrapCommand(args, { strict });
    }

    buildSpawnEnvironment() {
        const env = {
            ...process.env,
            OPENCLAW_HOME: this.managedHomeRoot,
            AIGRIL_OPENCLAW_HOME: this.managedHomeRoot,
            OPENCLAW_REPO: this.bundleRoot,
            AIGRIL_OPENCLAW_REPO: this.bundleRoot,
            OPENCLAW_SDK_PATH: this.getSdkPath(),
            AIGRIL_OPENCLAW_SDK_PATH: this.getSdkPath(),
            OPENCLAW_GATEWAY_URL: this.address.url,
            AIGRIL_OPENCLAW_GATEWAY_URL: this.address.url,
            HUMANCLAW_OPENCLAW_GATEWAY_URL: this.address.url,
            HUMANCLAW_OPENCLAW_HOME: this.managedHomeRoot,
            VBOX_USER_HOME: this.layout.virtualBoxHomeDir
        };

        if (!this.isVendorReady()) {
            env.ELECTRON_RUN_AS_NODE = '1';
        }

        return env;
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
        this.ensureHomeStructure();
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
            this.emitStatus();
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
                if (this.health === 'running') {
                    this.health = 'stopped';
                } else if (this.health !== 'disabled' && this.health !== 'external') {
                    this.health = 'error';
                }
                this.emitStatus();
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

        throw new Error(
            `等待 OpenClaw Gateway 监听 ${this.address.port} 超时${this.readFailureContext()}`
        );
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
                    clientVersion: 'operator-probe',
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
        this.emitStatus();
        this.spawnGatewayProcess(reset);
        await this.waitForGatewayProcessReady(reset ? 140000 : 100000);

        if (reset) {
            try {
                this.seedManagedConfig();
            } catch (error) {
                this.lastError = error instanceof Error ? error.message : String(error);
            }
        }

        const protocolReady = await this.probeGatewayProtocol();
        if (!protocolReady) {
            throw new Error(
                `${reset ? 'OpenClaw Gateway 自修复后仍未通过握手检查' : 'OpenClaw Gateway 握手检查失败'}${this.readFailureContext()}`
            );
        }

        this.health = 'running';
        this.lastError = '';
        this.emitStatus();
    }

    async ensureReady() {
        if (!this.isEnabled()) {
            await this.shutdown();
            return this.getStatus();
        }

        if (!this.address.managed) {
            await this.shutdown();
            this.health = 'external';
            this.lastError = 'Operator 内置 Gateway 仅接管本机回环地址，请把 Gateway 地址改成 127.0.0.1 或 localhost。';
            this.emitStatus();
            return this.getStatus();
        }

        if (!this.isBundleReady()) {
            this.health = 'error';
            this.lastError = '未找到内置 OpenClaw runtime，请先执行 pnpm openclaw:prepare-runtime 或重打 Operator 安装包。';
            this.emitStatus();
            throw new Error(this.lastError);
        }

        if (this.startPromise) {
            await this.startPromise;
            return this.getStatus();
        }

        this.startPromise = (async () => {
            this.applyEnvironment();
            this.ensureHomeStructure();
            try {
                this.seedManagedConfig();
                this.runDoctorRepair({ force: false, strict: false });
            } catch (error) {
                this.lastError = error instanceof Error ? error.message : String(error);
                this.health = 'repairing';
                this.emitStatus();
            }

            if (this.pendingRestart) {
                await this.stopChild();
                this.pendingRestart = false;
            }

            const alreadyHealthy = await this.probeGatewayProtocol();
            if (alreadyHealthy) {
                this.health = 'running';
                this.lastError = '';
                this.emitStatus();
                return;
            }

            try {
                await this.spawnAndVerify(false);
            } catch (error) {
                this.lastError = error instanceof Error ? error.message : String(error);
                this.health = 'repairing';
                this.emitStatus();
                this.seedManagedConfig();
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
        this.pendingRestart = false;
        await this.stopChild();
        this.health = this.isEnabled() ? 'stopped' : 'disabled';
        this.emitStatus();
        return this.getStatus();
    }
}

module.exports = {
    DEFAULT_GATEWAY_URL,
    OpenClawOperatorSupervisor
};
