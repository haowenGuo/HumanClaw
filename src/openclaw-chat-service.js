function normalizeText(value) {
    if (typeof value !== 'string') {
        return '';
    }
    return value.replace(/[ \t]+/g, ' ').trim();
}

function extractMessageText(message) {
    if (!message) {
        return '';
    }

    if (typeof message.content === 'string') {
        return normalizeText(message.content);
    }

    if (Array.isArray(message.content)) {
        const text = message.content
            .map((item) => normalizeText(item?.text))
            .filter(Boolean)
            .join('\n')
            .trim();
        return normalizeText(text);
    }

    return '';
}

function toAssistantPayload(text) {
    const normalized = normalizeText(text);
    return {
        raw_text: normalized,
        display_text: normalized,
        speech_text: normalized.replace(/\n/g, ' ')
    };
}

function mapHistoryMessage(message, index) {
    const role = normalizeText(message?.role).toLowerCase() || 'system';
    const content = extractMessageText(message);
    if (!content) {
        return null;
    }

    return {
        id: `openclaw-history-${index}`,
        role,
        content
    };
}

function getLatestUserMessage(messageHistory) {
    for (let index = messageHistory.length - 1; index >= 0; index -= 1) {
        if (messageHistory[index]?.role === 'user') {
            return normalizeText(messageHistory[index].content);
        }
    }
    return '';
}

export class OpenClawDesktopChatService {
    constructor() {
        this.assistant = window.aigrilDesktop?.assistant || null;
        this.pendingRuns = new Map();
        this.historyCache = [];
        this.initialized = false;
        this.sessionKey = 'main';
        this.supportsAutoChat = false;
        this.prefersThinkingState = true;
        this.unsubscribe = this.assistant?.onEvent?.((event) => {
            this.handleAssistantEvent(event);
        }) || null;
    }

    getWelcomeMessage() {
        return 'AIGL 已接入 OpenClaw，现在可以直接作为助手帮你干活。';
    }

    async ensureReady() {
        if (!this.assistant?.isSupported) {
            throw new Error('当前桌宠宿主不支持 OpenClaw 助手桥接');
        }

        if (this.initialized) {
            return;
        }

        const status = await this.assistant.getStatus();
        if (!status?.enabled) {
            throw new Error('OpenClaw 助手桥接未启用');
        }

        this.sessionKey = status.sessionKey || this.sessionKey;
        const history = await this.assistant.getHistory(200);
        this.sessionKey = history?.sessionKey || this.sessionKey;
        this.historyCache = Array.isArray(history?.messages)
            ? history.messages
                .map((message, index) => mapHistoryMessage(message, index))
                .filter(Boolean)
            : [];
        this.initialized = true;
    }

    async bootstrapTranscript() {
        await this.ensureReady();
        return {
            messages: this.historyCache,
            statusText: '已连接 OpenClaw'
        };
    }

    async fetchAssistantTurn({ messageHistory, isAutoChat = false, onProgress }) {
        if (isAutoChat) {
            throw new Error('OpenClaw 助手模式下已关闭主动闲聊');
        }

        await this.ensureReady();
        const message = getLatestUserMessage(messageHistory);
        if (!message) {
            throw new Error('消息不能为空');
        }

        const accepted = await this.assistant.sendMessage(message);
        const runId = normalizeText(accepted?.runId);
        if (!runId) {
            throw new Error('OpenClaw 未返回有效 runId');
        }

        return await new Promise((resolve, reject) => {
            this.pendingRuns.set(runId, {
                buffer: '',
                onProgress,
                resolve,
                reject
            });
        });
    }

    handleAssistantEvent(event) {
        if (!event?.type) {
            return;
        }

        if (event.type === 'status') {
            if (event.payload?.connected === false && this.pendingRuns.size > 0) {
                for (const [runId, pending] of this.pendingRuns) {
                    pending.reject(new Error(event.payload.lastError || 'OpenClaw Gateway 已断开'));
                    this.pendingRuns.delete(runId);
                }
            }
            return;
        }

        if (event.type === 'chat') {
            this.handleChatEvent(event.payload);
            return;
        }

        if (event.type === 'session.message') {
            this.handleSessionMessageEvent(event.payload);
        }
    }

    handleChatEvent(payload) {
        const runId = normalizeText(payload?.runId);
        if (!runId || payload?.sessionKey !== this.sessionKey) {
            return;
        }

        const pending = this.pendingRuns.get(runId);
        if (!pending) {
            return;
        }

        const text = extractMessageText(payload.message) || pending.buffer;
        if (payload.state === 'delta') {
            pending.buffer = text;
            pending.onProgress?.(toAssistantPayload(text));
            return;
        }

        if (payload.state === 'final') {
            this.pendingRuns.delete(runId);
            pending.resolve({
                ...toAssistantPayload(text),
                streamMode: true
            });
            return;
        }

        if (payload.state === 'error' || payload.state === 'aborted') {
            this.pendingRuns.delete(runId);
            pending.reject(new Error(payload.errorMessage || 'OpenClaw 执行失败'));
        }
    }

    handleSessionMessageEvent(payload) {
        if (payload?.sessionKey !== this.sessionKey || !payload?.message) {
            return;
        }

        const mapped = mapHistoryMessage(payload.message, this.historyCache.length);
        if (!mapped) {
            return;
        }

        const duplicate = this.historyCache.some(
            (item) => item.role === mapped.role && item.content === mapped.content
        );
        if (!duplicate) {
            this.historyCache.push(mapped);
        }
    }
}
