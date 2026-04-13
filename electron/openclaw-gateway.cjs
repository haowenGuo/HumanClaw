const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { pathToFileURL } = require('url');

const DEFAULT_GATEWAY_URL =
    process.env.AIGRIL_OPENCLAW_GATEWAY_URL ||
    process.env.OPENCLAW_GATEWAY_URL ||
    'ws://127.0.0.1:18789';
const DEFAULT_SESSION_KEY =
    process.env.AIGRIL_OPENCLAW_SESSION_KEY ||
    process.env.OPENCLAW_SESSION_KEY ||
    'main';
const DEFAULT_PROTOCOL_VERSION = 3;
const DEFAULT_CONNECT_TIMEOUT_MS = 12000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_GATEWAY_URL_FALLBACKS = [
    'ws://127.0.0.1:18789',
    'ws://127.0.0.1:19011'
];

let gatewayRuntimePromise = null;

function normalizeOptionalString(value) {
    if (typeof value !== 'string') {
        return '';
    }
    return value.trim();
}

function dedupeStrings(values) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
        const normalized = normalizeOptionalString(value);
        if (!normalized || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        result.push(normalized);
    }
    return result;
}

function toGatewayWsUrl(rawUrl) {
    const normalized = normalizeOptionalString(rawUrl);
    if (!normalized) {
        return '';
    }
    if (/^wss?:\/\//i.test(normalized)) {
        return normalized;
    }
    if (/^https?:\/\//i.test(normalized)) {
        return normalized.replace(/^http/i, 'ws');
    }
    return `ws://${normalized}`;
}

function buildGatewayUrlCandidates(rawUrl) {
    const explicitUrl = normalizeOptionalString(rawUrl);
    if (explicitUrl) {
        return [toGatewayWsUrl(explicitUrl)];
    }

    return dedupeStrings([
        toGatewayWsUrl(process.env.AIGRIL_OPENCLAW_GATEWAY_URL),
        toGatewayWsUrl(process.env.OPENCLAW_GATEWAY_URL),
        ...DEFAULT_GATEWAY_URL_FALLBACKS
    ]);
}

function createTimeoutError(message) {
    const error = new Error(message);
    error.code = 'AIGRIL_TIMEOUT';
    return error;
}

function fileExists(targetPath) {
    try {
        return fs.existsSync(targetPath);
    } catch {
        return false;
    }
}

function resolveExistingPath(candidates) {
    for (const candidate of candidates) {
        const normalized = normalizeOptionalString(candidate);
        if (!normalized) {
            continue;
        }
        if (fileExists(normalized)) {
            return normalized;
        }
    }
    return '';
}

function resolveOpenClawHome() {
    const explicit =
        normalizeOptionalString(process.env.AIGRIL_OPENCLAW_HOME) ||
        normalizeOptionalString(process.env.OPENCLAW_HOME);
    if (explicit) {
        return explicit;
    }

    const homeDir = os.homedir();
    const candidates = [
        path.join(homeDir, '.openclaw-source-dev'),
        path.join(homeDir, '.openclaw')
    ];

    for (const candidate of candidates) {
        if (
            fileExists(path.join(candidate, 'openclaw.json')) ||
            fileExists(path.join(candidate, 'identity', 'device.json')) ||
            fileExists(path.join(candidate, 'devices', 'paired.json'))
        ) {
            return candidate;
        }
    }

    return '';
}

function resolveGatewayRuntimeCandidates() {
    const repoHints = dedupeStrings([
        normalizeOptionalString(process.env.AIGRIL_OPENCLAW_REPO),
        normalizeOptionalString(process.env.OPENCLAW_REPO),
        path.resolve(__dirname, '..', '..', 'HumanClaw', 'OPENCLAW_Lobster'),
        path.resolve(__dirname, '..', '..', 'OPENCLAW_Lobster'),
        path.resolve(process.cwd(), '..', 'HumanClaw', 'OPENCLAW_Lobster'),
        path.resolve(process.cwd(), '..', 'OPENCLAW_Lobster'),
        'F:\\HumanClaw\\OPENCLAW_Lobster'
    ]);

    return dedupeStrings([
        normalizeOptionalString(process.env.AIGRIL_OPENCLAW_SDK_PATH),
        normalizeOptionalString(process.env.OPENCLAW_SDK_PATH),
        ...repoHints.map((repoPath) => path.join(repoPath, 'dist', 'plugin-sdk', 'gateway-runtime.js'))
    ]);
}

async function loadGatewayRuntime() {
    if (!gatewayRuntimePromise) {
        gatewayRuntimePromise = (async () => {
            const openClawHome = resolveOpenClawHome();
            if (openClawHome && !normalizeOptionalString(process.env.OPENCLAW_HOME)) {
                process.env.OPENCLAW_HOME = openClawHome;
            }

            try {
                return await import('openclaw/plugin-sdk/gateway-runtime');
            } catch {}

            const runtimePath = resolveExistingPath(resolveGatewayRuntimeCandidates());
            if (!runtimePath) {
                throw new Error(
                    '未找到 OpenClaw Gateway runtime，请设置 AIGRIL_OPENCLAW_SDK_PATH / AIGRIL_OPENCLAW_REPO'
                );
            }

            return await import(pathToFileURL(runtimePath).href);
        })();
    }

    return await gatewayRuntimePromise;
}

class OpenClawGatewayManager extends EventEmitter {
    constructor(options = {}) {
        super();

        const token =
            normalizeOptionalString(options.token) ||
            normalizeOptionalString(process.env.AIGRIL_OPENCLAW_GATEWAY_TOKEN) ||
            normalizeOptionalString(process.env.OPENCLAW_GATEWAY_TOKEN);
        const password =
            normalizeOptionalString(options.password) ||
            normalizeOptionalString(process.env.AIGRIL_OPENCLAW_GATEWAY_PASSWORD) ||
            normalizeOptionalString(process.env.OPENCLAW_GATEWAY_PASSWORD);
        const sessionKey = normalizeOptionalString(options.sessionKey) || DEFAULT_SESSION_KEY;
        const gatewayUrls = buildGatewayUrlCandidates(options.gatewayUrl);

        this.config = {
            enabled: options.enabled !== false,
            gatewayUrls: gatewayUrls.length > 0 ? gatewayUrls : [DEFAULT_GATEWAY_URL],
            token,
            password,
            sessionKey,
            clientVersion: options.clientVersion || 'dev'
        };

        this.client = null;
        this.connectPromise = null;
        this.connected = false;
        this.connectedAt = 0;
        this.lastError = '';
        this.sessionKey = sessionKey;
        this.sessionSubscriptionsReady = false;
        this.historyCache = [];
        this.messageIds = new Set();
        this.closedManually = false;
        this.activeGatewayUrl = this.config.gatewayUrls[0];
    }

    getStatus() {
        return {
            enabled: this.config.enabled,
            connected: this.connected,
            connecting: Boolean(this.connectPromise),
            gatewayUrl: this.activeGatewayUrl,
            sessionKey: this.sessionKey,
            lastError: this.lastError,
            connectedAt: this.connectedAt,
            authMode: this.config.token ? 'token' : this.config.password ? 'password' : 'none',
            protocolVersion: DEFAULT_PROTOCOL_VERSION
        };
    }

    emitStatus() {
        this.emit('status', this.getStatus());
    }

    async ensureConnected() {
        if (!this.config.enabled) {
            throw new Error('OpenClaw assistant bridge is disabled');
        }

        if (this.connected) {
            if (!this.sessionSubscriptionsReady) {
                await this.ensureSessionSubscriptions();
            }
            return this.getStatus();
        }

        if (this.connectPromise) {
            await this.connectPromise;
            return this.getStatus();
        }

        this.connectPromise = this.connectWithFallback().finally(() => {
            this.connectPromise = null;
        });
        await this.connectPromise;
        return this.getStatus();
    }

    async connectWithFallback() {
        const runtime = await loadGatewayRuntime();
        const GatewayClient = runtime?.GatewayClient;
        if (!GatewayClient) {
            throw new Error('OpenClaw Gateway runtime 未导出 GatewayClient');
        }

        let lastFailure = null;

        for (const gatewayUrl of this.config.gatewayUrls) {
            try {
                await this.connectSingle(GatewayClient, gatewayUrl);
                this.activeGatewayUrl = gatewayUrl;
                this.lastError = '';
                await this.ensureSessionSubscriptions();
                return;
            } catch (error) {
                lastFailure = error instanceof Error ? error : new Error(String(error));
                this.lastError = lastFailure.message;
                this.emitStatus();
                await this.teardownClient();
            }
        }

        throw lastFailure || new Error('OpenClaw Gateway 连接失败');
    }

    async connectSingle(GatewayClient, gatewayUrl) {
        await this.teardownClient();
        this.closedManually = false;
        this.connected = false;
        this.connectedAt = 0;
        this.sessionSubscriptionsReady = false;
        this.emitStatus();

        await new Promise((resolve, reject) => {
            let settled = false;

            const finishResolve = () => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                this.connected = true;
                this.connectedAt = Date.now();
                this.lastError = '';
                this.activeGatewayUrl = gatewayUrl;
                this.emitStatus();
                resolve();
            };

            const finishReject = (error) => {
                const resolvedError = error instanceof Error ? error : new Error(String(error));
                if (settled) {
                    this.connected = false;
                    this.connectedAt = 0;
                    this.lastError = resolvedError.message;
                    this.sessionSubscriptionsReady = false;
                    this.emitStatus();
                    return;
                }

                settled = true;
                clearTimeout(timer);
                this.connected = false;
                this.connectedAt = 0;
                this.lastError = resolvedError.message;
                this.sessionSubscriptionsReady = false;
                this.emitStatus();
                reject(resolvedError);
            };

            const timer = setTimeout(() => {
                finishReject(createTimeoutError('连接 OpenClaw Gateway 超时'));
            }, DEFAULT_CONNECT_TIMEOUT_MS);

            this.client = new GatewayClient({
                url: gatewayUrl,
                token: this.config.token || undefined,
                password: this.config.password || undefined,
                clientName: 'gateway-client',
            clientDisplayName: 'HumanClaw Desktop',
                clientVersion: this.config.clientVersion || 'dev',
                platform: process.platform,
                mode: 'backend',
                role: 'operator',
                scopes: ['operator.read', 'operator.write'],
                requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
                onHelloOk: () => {
                    finishResolve();
                },
                onEvent: (frame) => {
                    this.handleGatewayFrame(frame);
                },
                onConnectError: (error) => {
                    finishReject(error);
                },
                onClose: (_code, reason) => {
                    this.connected = false;
                    this.connectedAt = 0;
                    this.sessionSubscriptionsReady = false;
                    if (!this.closedManually) {
                        this.lastError = normalizeOptionalString(reason) || 'OpenClaw Gateway 连接已断开';
                    }
                    this.emitStatus();
                }
            });

            try {
                this.client.start();
            } catch (error) {
                finishReject(error);
            }
        });
    }

    async teardownClient() {
        if (!this.client) {
            return;
        }

        const client = this.client;
        this.client = null;

        try {
            if (typeof client.stopAndWait === 'function') {
                await client.stopAndWait({ timeoutMs: 3000 });
            } else if (typeof client.stop === 'function') {
                client.stop();
            }
        } catch {}

        this.connected = false;
        this.connectedAt = 0;
        this.sessionSubscriptionsReady = false;
    }

    async request(method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
        await this.ensureConnected();
        return await this.requestDirect(method, params, timeoutMs);
    }

    async requestDirect(method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
        if (!this.client) {
            throw new Error('OpenClaw Gateway 尚未连接');
        }

        try {
            return await this.client.request(method, params, { timeoutMs });
        } catch (error) {
            this.lastError = error instanceof Error ? error.message : String(error);
            this.emitStatus();
            throw error;
        }
    }

    async ensureSessionSubscriptions() {
        if (this.sessionSubscriptionsReady) {
            return;
        }

        await this.requestDirect('sessions.subscribe', {}, DEFAULT_REQUEST_TIMEOUT_MS);
        const subscription = await this.requestDirect(
            'sessions.messages.subscribe',
            { key: this.sessionKey },
            DEFAULT_REQUEST_TIMEOUT_MS
        );
        const canonicalKey = normalizeOptionalString(subscription?.key);
        if (canonicalKey) {
            this.sessionKey = canonicalKey;
        }
        this.sessionSubscriptionsReady = true;
        this.emitStatus();
    }

    async setSessionKey(nextSessionKey) {
        const normalized = normalizeOptionalString(nextSessionKey);
        if (!normalized || normalized === this.sessionKey) {
            return this.getStatus();
        }

        const previous = this.sessionKey;
        this.sessionKey = normalized;
        this.historyCache = [];
        this.messageIds.clear();

        if (this.connected) {
            try {
                await this.request('sessions.messages.unsubscribe', { key: previous });
            } catch {}
            this.sessionSubscriptionsReady = false;
            await this.ensureSessionSubscriptions();
        }

        this.emit('event', {
            type: 'session.switched',
            payload: {
                previousSessionKey: previous,
                sessionKey: this.sessionKey
            }
        });
        return this.getStatus();
    }

    async getHistory(limit = 200) {
        const payload = await this.request('chat.history', {
            sessionKey: this.sessionKey,
            limit
        });
        this.historyCache = Array.isArray(payload?.messages) ? payload.messages : [];
        this.rebuildHistoryIndex();
        return payload;
    }

    rebuildHistoryIndex() {
        this.messageIds.clear();
        for (const message of this.historyCache) {
            const key = this.buildMessageIdentity(message);
            if (key) {
                this.messageIds.add(key);
            }
        }
    }

    buildMessageIdentity(message) {
        if (!message || typeof message !== 'object') {
            return '';
        }
        const role = normalizeOptionalString(message.role).toLowerCase();
        const timestamp = Number.isFinite(message.timestamp) ? String(message.timestamp) : '';
        const text = Array.isArray(message.content)
            ? message.content
                .map((item) => normalizeOptionalString(item?.text))
                .filter(Boolean)
                .join('\n')
            : normalizeOptionalString(message.content);
        return [role, timestamp, text].filter(Boolean).join('|');
    }

    appendHistoryMessage(message) {
        const identity = this.buildMessageIdentity(message);
        if (!identity || this.messageIds.has(identity)) {
            return false;
        }
        this.messageIds.add(identity);
        this.historyCache.push(message);
        return true;
    }

    async sendMessage(content, options = {}) {
        const message = normalizeOptionalString(content);
        if (!message) {
            throw new Error('消息不能为空');
        }

        return await this.request(
            'chat.send',
            {
                sessionKey: this.sessionKey,
                message,
                idempotencyKey: randomUUID()
            },
            Number(options.timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS
        );
    }

    async abortRun(runId) {
        return await this.request('chat.abort', {
            sessionKey: this.sessionKey,
            runId: normalizeOptionalString(runId) || undefined
        });
    }

    async listSessions(limit = 20) {
        return await this.request('sessions.list', { limit });
    }

    async patchSession(patch = {}) {
        return await this.request('sessions.patch', {
            key: this.sessionKey,
            ...patch
        });
    }

    matchesSessionKey(nextSessionKey) {
        return normalizeOptionalString(nextSessionKey) === this.sessionKey;
    }

    handleGatewayFrame(frame) {
        if (!frame || frame.type !== 'event') {
            return;
        }

        const eventName = normalizeOptionalString(frame.event);
        const payload = frame.payload || {};

        if (eventName === 'tick') {
            this.emitStatus();
            return;
        }

        if (eventName === 'chat') {
            if (!this.matchesSessionKey(payload.sessionKey)) {
                return;
            }
            this.emit('event', { type: 'chat', payload });
            return;
        }

        if (eventName === 'session.message') {
            if (!this.matchesSessionKey(payload.sessionKey)) {
                return;
            }
            if (payload.message) {
                this.appendHistoryMessage(payload.message);
            }
            this.emit('event', { type: 'session.message', payload });
            return;
        }

        if (eventName === 'session.tool') {
            if (!this.matchesSessionKey(payload.sessionKey)) {
                return;
            }
            this.emit('event', { type: 'session.tool', payload });
            return;
        }

        if (eventName === 'sessions.changed') {
            if (payload.sessionKey && !this.matchesSessionKey(payload.sessionKey)) {
                return;
            }
            this.emit('event', { type: 'sessions.changed', payload });
        }
    }

    async shutdown() {
        this.closedManually = true;
        await this.teardownClient();
        this.emitStatus();
    }
}

module.exports = {
    DEFAULT_GATEWAY_URL,
    DEFAULT_SESSION_KEY,
    OpenClawGatewayManager,
    toGatewayWsUrl
};
