import { VRMModelSystem } from './vrm-model-system.js';
import { TTSAudioPlayer } from './tts-audio-player.js';
import { ChatTTSSystem } from './chat-tts-system.js';
import { createChatService } from './chat-service.js';
import { createSpeechProvider } from './speech-provider.js';
import { applyDesktopPreferencesToConfig } from './config.js';


window.addEventListener('DOMContentLoaded', async () => {
    applyDesktopPreferencesToConfig(window.aigrilDesktop?.preferences || window.aigrilDesktop?.runtimeConfig || {});
    const vrmSystem = new VRMModelSystem();
    const audioPlayer = new TTSAudioPlayer(vrmSystem);
    const buildChatService = () => createChatService();
    let chatService = buildChatService();
    let backendSignature = JSON.stringify({
        backendMode: window.aigrilDesktop?.preferences?.backendMode || 'companion-service',
        openclawGatewayUrl: window.aigrilDesktop?.preferences?.openclawGatewayUrl || ''
    });
    const buildSpeechProvider = (speechMode = null) => createSpeechProvider({
        enableTTS: true,
        speechMode
    });
    let speechProvider = buildSpeechProvider(window.aigrilDesktop?.preferences?.speechMode);
    const chatSystem = new ChatTTSSystem(vrmSystem, audioPlayer, chatService, {
        speechProvider
    });

    window.aigrilDesktop?.onPreferencesUpdated?.(({ preferences = {} } = {}) => {
        applyDesktopPreferencesToConfig(preferences);
        speechProvider?.dispose?.();
        speechProvider = buildSpeechProvider(preferences.speechMode);
        chatSystem.setSpeechProvider(speechProvider);
        const nextBackendSignature = JSON.stringify({
            backendMode: preferences.backendMode || 'companion-service',
            openclawGatewayUrl: preferences.openclawGatewayUrl || ''
        });
        if (nextBackendSignature !== backendSignature) {
            chatService = buildChatService();
            chatSystem.setChatService?.(chatService);
            backendSignature = nextBackendSignature;
            const backendLabel = preferences.backendMode === 'openclaw-local'
                ? 'OpenClaw 助手后端'
                : '陪伴后端';
            chatSystem.addSystemMessage(`已切换到${backendLabel}。`);
            window.chatService = chatService;
        }
        chatSystem.applyRuntimePreferences?.();
        vrmSystem.applyPreferences?.();
        window.speechProvider = speechProvider;
    });

    vrmSystem.init('canvas-container');
    await vrmSystem.loadModel();

    window.vrmSystem = vrmSystem;
    window.audioPlayer = audioPlayer;
    window.chatService = chatService;
    window.chatSystem = chatSystem;
    window.speechProvider = speechProvider;

    window.addEventListener('beforeunload', () => {
        speechProvider?.dispose?.();
    });
});
